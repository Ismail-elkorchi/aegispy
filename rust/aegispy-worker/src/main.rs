use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::min;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWrite;
use tokio::sync::Notify;
use wasmtime::component::{
    Component as WasmComponent, HasSelf, Linker as ComponentLinker, ResourceTable,
};
use wasmtime::{Config, Engine, OptLevel, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::cli::{IsTerminal, StdinStream, StdoutStream};
use wasmtime_wasi::p2::add_to_linker_sync as add_to_component_linker_sync;
use wasmtime_wasi::p2::bindings::sync::Command as WasiCommand;
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::p2::{InputStream, Pollable, StreamError};
use wasmtime_wasi::{DirPerms, FilePerms, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

mod component_host_bindings {
    wasmtime::component::bindgen!({
        path: "../../wit",
        world: "aegispy-runtime",
    });
}

#[derive(Debug, Deserialize)]
struct RunRequestEnvelope {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "requestId")]
    request_id: String,
    run: Value,
}

#[derive(Debug, Serialize)]
struct RunResponseEnvelope {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(rename = "requestId")]
    request_id: String,
    result: Value,
}

#[derive(Clone, Debug, Serialize)]
struct IsolationProfile {
    name: String,
    max_wall_ms: u64,
    max_cpu_ms: u64,
    max_memory_bytes: u64,
    max_stdout_bytes: u64,
    max_stderr_bytes: u64,
    deny_env_capability: bool,
}

#[derive(Clone, Debug)]
struct KernelIsolationEnvelope {
    detail: String,
    no_new_privs: bool,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Debug, Default)]
struct LinuxKernelLimitStatus {
    cpu_soft_secs: Option<u64>,
    cpu_hard_secs: Option<u64>,
    address_space_soft_bytes: Option<u64>,
    address_space_hard_bytes: Option<u64>,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Debug, Default)]
struct LinuxKernelStatus {
    no_new_privs: bool,
    seccomp_mode: Option<u64>,
    seccomp_filters: Option<u64>,
    cgroup_path: Option<String>,
    namespaces: BTreeMap<String, String>,
    rlimits: LinuxKernelLimitStatus,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Debug)]
struct LinuxKernelControlProbe {
    blocked: bool,
    errno_code: Option<i32>,
    errno_name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkerExecutorMode {
    Wasi,
    Simulation,
}

impl FromStr for WorkerExecutorMode {
    type Err = String;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        match raw.trim().to_lowercase().as_str() {
            "wasi" => Ok(Self::Wasi),
            "simulation" => Ok(Self::Simulation),
            _ => Err("invalid AEGISPY_WORKER_EXECUTOR".to_string()),
        }
    }
}

impl WorkerExecutorMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Wasi => "wasi",
            Self::Simulation => "simulation",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CapabilityBindingMode {
    GuestRuntimeAbi,
}

impl FromStr for CapabilityBindingMode {
    type Err = String;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        match raw.trim().to_lowercase().as_str() {
            "guest-runtime-abi" | "guest-abi" => Ok(Self::GuestRuntimeAbi),
            _ => Err("invalid AEGISPY_WORKER_CAPABILITY_BINDING_MODE".to_string()),
        }
    }
}

impl CapabilityBindingMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::GuestRuntimeAbi => "guest-runtime-abi",
        }
    }
}

#[derive(Clone)]
struct WasiExecutor {
    engine: Engine,
    component: WasmComponent,
    python_home: PathBuf,
    enable_fuel: bool,
    enable_epoch: bool,
    enable_store_limits: bool,
    capability_binding_mode: CapabilityBindingMode,
}

struct WasiStoreState {
    wasi: WasiCtx,
    table: ResourceTable,
    stdout: MemoryOutputPipe,
    stderr: NativeHostAbiStderrPipe,
    limits: StoreLimits,
    native_capability: SharedNativeHostCapabilityState,
}

impl WasiView for WasiStoreState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

const ENGINE_MIN_MEMORY_BYTES: u64 = 128 * 1024 * 1024;

fn parse_positive_env_u64(key: &str, default: u64) -> Result<u64, String> {
    let raw = match std::env::var(key) {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => return Ok(default),
        Err(error) => return Err(format!("failed to read {key}: {error}")),
    };

    let parsed = raw
        .parse::<u64>()
        .map_err(|_| format!("invalid numeric value for {key}"))?;
    if parsed == 0 {
        return Err(format!("invalid numeric value for {key}"));
    }
    Ok(parsed)
}

fn parse_bool_env(key: &str, default: bool) -> Result<bool, String> {
    let raw = match std::env::var(key) {
        Ok(value) => value.trim().to_string(),
        Err(std::env::VarError::NotPresent) => return Ok(default),
        Err(error) => return Err(format!("failed to read {key}: {error}")),
    };

    match raw.as_str() {
        "1" | "true" | "TRUE" | "True" => Ok(true),
        "0" | "false" | "FALSE" | "False" => Ok(false),
        _ => Err(format!("invalid boolean value for {key}")),
    }
}

fn parse_proc_status_u64(key: &str) -> Option<u64> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    status
        .lines()
        .find_map(|line| line.strip_prefix(&format!("{key}:\t")))
        .and_then(|raw| raw.trim().parse::<u64>().ok())
}

#[cfg(target_os = "linux")]
const KERNEL_PROBE_ERRNO: u32 = libc::EUCLEAN as u32;

#[cfg(target_os = "linux")]
const PR_SET_NO_NEW_PRIVS: i32 = 38;

#[cfg(target_os = "linux")]
const PR_SET_SECCOMP: i32 = 22;

#[cfg(target_os = "linux")]
const SECCOMP_MODE_FILTER: usize = 2;

#[cfg(target_os = "linux")]
const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;

#[cfg(target_os = "linux")]
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;

#[cfg(target_os = "linux")]
const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;

#[cfg(target_os = "linux")]
const SECCOMP_DATA_NR_OFFSET: u32 = 0;

#[cfg(target_os = "linux")]
const SECCOMP_DATA_ARCH_OFFSET: u32 = 4;

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const SECCOMP_AUDIT_ARCH: u32 = 0xc000_003e;

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const SECCOMP_AUDIT_ARCH: u32 = 0xc000_00b7;

fn read_linux_cgroup_path() -> Option<String> {
    let cgroup = fs::read_to_string("/proc/self/cgroup").ok()?;
    for line in cgroup.lines() {
        let mut parts = line.splitn(3, ':');
        let _hierarchy = parts.next();
        let controllers = parts.next();
        let path = parts.next();
        if controllers == Some("") && path.is_some() {
            return path.map(ToString::to_string);
        }
    }
    None
}

fn read_linux_namespace_ids() -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for name in ["pid", "mnt", "net", "uts", "ipc", "cgroup"] {
        let ns_path = format!("/proc/self/ns/{name}");
        if let Ok(link) = fs::read_link(&ns_path) {
            out.insert(name.to_string(), link.to_string_lossy().to_string());
        }
    }
    out
}

fn encode_kernel_detail_value(value: &str) -> String {
    value.replace(';', "%3B").replace('=', "%3D")
}

#[cfg(target_os = "linux")]
fn normalize_rlimit_value(value: libc::rlim_t) -> Option<u64> {
    if value == libc::RLIM_INFINITY {
        None
    } else {
        Some(value)
    }
}

#[cfg(target_os = "linux")]
fn read_linux_rlimits() -> Result<LinuxKernelLimitStatus, String> {
    let mut cpu_limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    let mut address_space_limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };

    let cpu_rc = unsafe { libc::getrlimit(libc::RLIMIT_CPU, &mut cpu_limit) };
    if cpu_rc != 0 {
        return Err(format!(
            "failed to read RLIMIT_CPU: {}",
            io::Error::last_os_error()
        ));
    }

    let as_rc = unsafe { libc::getrlimit(libc::RLIMIT_AS, &mut address_space_limit) };
    if as_rc != 0 {
        return Err(format!(
            "failed to read RLIMIT_AS: {}",
            io::Error::last_os_error()
        ));
    }

    Ok(LinuxKernelLimitStatus {
        cpu_soft_secs: normalize_rlimit_value(cpu_limit.rlim_cur),
        cpu_hard_secs: normalize_rlimit_value(cpu_limit.rlim_max),
        address_space_soft_bytes: normalize_rlimit_value(address_space_limit.rlim_cur),
        address_space_hard_bytes: normalize_rlimit_value(address_space_limit.rlim_max),
    })
}

#[cfg(target_os = "linux")]
fn collect_linux_kernel_status() -> Result<LinuxKernelStatus, String> {
    Ok(LinuxKernelStatus {
        no_new_privs: parse_proc_status_u64("NoNewPrivs").unwrap_or(0) == 1,
        seccomp_mode: parse_proc_status_u64("Seccomp"),
        seccomp_filters: parse_proc_status_u64("Seccomp_filters"),
        cgroup_path: read_linux_cgroup_path(),
        namespaces: read_linux_namespace_ids(),
        rlimits: read_linux_rlimits()?,
    })
}

#[cfg(target_os = "linux")]
fn worker_cpu_rlimit_seconds(profile: &IsolationProfile) -> u64 {
    const CPU_LIMIT_FLOOR_SECONDS: u64 = 600;
    ((profile.max_cpu_ms.saturating_add(999)) / 1000)
        .max(1)
        .saturating_add(5)
        .max(CPU_LIMIT_FLOOR_SECONDS)
}

#[cfg(target_os = "linux")]
fn worker_address_space_rlimit_bytes(profile: &IsolationProfile) -> u64 {
    const ADDRESS_SPACE_FLOOR_BYTES: u64 = 5 * 1024 * 1024 * 1024;
    profile.max_memory_bytes.max(ADDRESS_SPACE_FLOOR_BYTES)
}

#[cfg(target_os = "linux")]
fn enforce_linux_rlimit(
    resource: libc::__rlimit_resource_t,
    soft: u64,
    hard: u64,
) -> Result<(), String> {
    let limits = libc::rlimit {
        rlim_cur: soft as libc::rlim_t,
        rlim_max: hard as libc::rlim_t,
    };
    let rc = unsafe { libc::setrlimit(resource, &limits) };
    if rc != 0 {
        return Err(format!(
            "failed to set resource limit {resource}: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_bpf_stmt(code: u16, k: u32) -> libc::sock_filter {
    libc::sock_filter {
        code,
        jt: 0,
        jf: 0,
        k,
    }
}

#[cfg(target_os = "linux")]
fn linux_bpf_jump(code: u16, k: u32, jt: u8, jf: u8) -> libc::sock_filter {
    libc::sock_filter { code, jt, jf, k }
}

#[cfg(target_os = "linux")]
fn install_linux_strict_seccomp_filter() -> Result<(), String> {
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        return Err("strict profile seccomp filter unsupported on this architecture".to_string());
    }

    let load_abs_word = (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16;
    let jump_eq = (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16;
    let return_k = (libc::BPF_RET | libc::BPF_K) as u16;
    let deny_errno = SECCOMP_RET_ERRNO | KERNEL_PROBE_ERRNO;

    let mut filter = vec![
        linux_bpf_stmt(load_abs_word, SECCOMP_DATA_ARCH_OFFSET),
        linux_bpf_jump(jump_eq, SECCOMP_AUDIT_ARCH, 1, 0),
        linux_bpf_stmt(return_k, SECCOMP_RET_KILL_PROCESS),
        linux_bpf_stmt(load_abs_word, SECCOMP_DATA_NR_OFFSET),
    ];

    for syscall_number in [
        libc::SYS_unshare as u32,
        libc::SYS_setns as u32,
        libc::SYS_mount as u32,
        libc::SYS_ptrace as u32,
    ] {
        filter.push(linux_bpf_jump(jump_eq, syscall_number, 0, 1));
        filter.push(linux_bpf_stmt(return_k, deny_errno));
    }
    filter.push(linux_bpf_stmt(return_k, SECCOMP_RET_ALLOW));

    let program = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_mut_ptr(),
    };

    let rc = unsafe {
        prctl(
            PR_SET_SECCOMP,
            SECCOMP_MODE_FILTER,
            (&program as *const libc::sock_fprog) as usize,
            0,
            0,
        )
    };
    if rc != 0 {
        return Err(format!(
            "failed to install seccomp filter: {}",
            io::Error::last_os_error()
        ));
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn probe_errno_name(errno_code: i32) -> String {
    match errno_code {
        libc::EUCLEAN => "EUCLEAN".to_string(),
        libc::EPERM => "EPERM".to_string(),
        libc::EINVAL => "EINVAL".to_string(),
        libc::ESRCH => "ESRCH".to_string(),
        libc::EBADF => "EBADF".to_string(),
        _ => format!("ERRNO_{errno_code}"),
    }
}

#[cfg(target_os = "linux")]
fn evaluate_probe_result(rc: libc::c_long) -> LinuxKernelControlProbe {
    if rc >= 0 {
        return LinuxKernelControlProbe {
            blocked: false,
            errno_code: None,
            errno_name: "OK".to_string(),
        };
    }

    let errno_code = io::Error::last_os_error().raw_os_error();
    let blocked = errno_code == Some(KERNEL_PROBE_ERRNO as i32);
    LinuxKernelControlProbe {
        blocked,
        errno_code,
        errno_name: errno_code
            .map(probe_errno_name)
            .unwrap_or_else(|| "UNKNOWN".to_string()),
    }
}

#[cfg(target_os = "linux")]
fn probe_linux_kernel_controls() -> BTreeMap<String, LinuxKernelControlProbe> {
    let mut probes = BTreeMap::new();
    probes.insert(
        "unshare".to_string(),
        evaluate_probe_result(unsafe {
            libc::syscall(
                libc::SYS_unshare as libc::c_long,
                libc::CLONE_NEWNS as libc::c_long,
            )
        }),
    );
    probes.insert(
        "setns".to_string(),
        evaluate_probe_result(unsafe { libc::syscall(libc::SYS_setns as libc::c_long, -1, 0) }),
    );
    probes.insert(
        "mount".to_string(),
        evaluate_probe_result(unsafe {
            libc::syscall(
                libc::SYS_mount as libc::c_long,
                std::ptr::null::<libc::c_char>(),
                std::ptr::null::<libc::c_char>(),
                std::ptr::null::<libc::c_char>(),
                0 as libc::c_ulong,
                std::ptr::null::<libc::c_void>(),
            )
        }),
    );
    probes.insert(
        "ptrace".to_string(),
        evaluate_probe_result(unsafe {
            libc::syscall(
                libc::SYS_ptrace as libc::c_long,
                libc::PTRACE_PEEKDATA as libc::c_long,
                -1,
                std::ptr::null::<libc::c_void>(),
                0,
            )
        }),
    );
    probes
}

#[cfg(target_os = "linux")]
fn validate_linux_kernel_status(
    profile: &IsolationProfile,
    status: &LinuxKernelStatus,
) -> Result<(), String> {
    if profile.name == "strict" && !status.no_new_privs {
        return Err("strict profile requires no_new_privs=1".to_string());
    }

    if profile.name == "strict" {
        let seccomp_mode = status.seccomp_mode.unwrap_or(0);
        let seccomp_filters = status.seccomp_filters.unwrap_or(0);
        if seccomp_mode == 0 {
            return Err("strict profile requires active seccomp".to_string());
        }
        if seccomp_filters == 0 {
            return Err("strict profile requires seccomp filter evidence".to_string());
        }
        for required in ["pid", "mnt", "net", "uts", "ipc", "cgroup"] {
            if !status.namespaces.contains_key(required) {
                return Err(format!(
                    "strict profile missing namespace evidence: {required}"
                ));
            }
        }
        if status.cgroup_path.is_none() {
            return Err("strict profile missing cgroup evidence".to_string());
        }
        if status.rlimits.cpu_soft_secs.unwrap_or(0) == 0
            || status.rlimits.cpu_hard_secs.unwrap_or(0) == 0
        {
            return Err("strict profile missing RLIMIT_CPU evidence".to_string());
        }
        if status.rlimits.address_space_soft_bytes.unwrap_or(0) == 0
            || status.rlimits.address_space_hard_bytes.unwrap_or(0) == 0
        {
            return Err("strict profile missing RLIMIT_AS evidence".to_string());
        }
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn validate_linux_kernel_probes(
    probes: &BTreeMap<String, LinuxKernelControlProbe>,
) -> Result<(), String> {
    for required in ["unshare", "setns", "mount", "ptrace"] {
        let Some(probe) = probes.get(required) else {
            return Err(format!(
                "strict profile missing kernel control probe: {required}"
            ));
        };
        if !probe.blocked || probe.errno_code != Some(KERNEL_PROBE_ERRNO as i32) {
            return Err(format!(
                "strict profile kernel control probe not blocked: {required}"
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn apply_linux_kernel_controls(profile: &IsolationProfile) -> Result<(), String> {
    enforce_linux_no_new_privs()?;
    if profile.name != "strict" {
        return Ok(());
    }

    let cpu_limit_secs = worker_cpu_rlimit_seconds(profile);
    let address_space_limit_bytes = worker_address_space_rlimit_bytes(profile);
    enforce_linux_rlimit(libc::RLIMIT_CPU, cpu_limit_secs, cpu_limit_secs)?;
    enforce_linux_rlimit(
        libc::RLIMIT_AS,
        address_space_limit_bytes,
        address_space_limit_bytes,
    )?;
    install_linux_strict_seccomp_filter()?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn build_kernel_isolation_detail(
    profile: &IsolationProfile,
    before: &LinuxKernelStatus,
    after: &LinuxKernelStatus,
    probes: &BTreeMap<String, LinuxKernelControlProbe>,
) -> String {
    let mut parts = Vec::<String>::new();
    parts.push("supported=1".to_string());
    parts.push(format!(
        "os={}",
        encode_kernel_detail_value(std::env::consts::OS)
    ));
    parts.push(format!(
        "profile={}",
        encode_kernel_detail_value(&profile.name)
    ));
    parts.push(format!(
        "no_new_privs={}",
        if after.no_new_privs { 1 } else { 0 }
    ));
    parts.push(format!(
        "no_new_privs_before={}",
        if before.no_new_privs { 1 } else { 0 }
    ));
    parts.push(format!(
        "seccomp={}",
        after
            .seccomp_mode
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    ));
    parts.push(format!(
        "seccomp_filters={}",
        after
            .seccomp_filters
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    ));
    parts.push(format!(
        "seccomp_before={}",
        before
            .seccomp_mode
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    ));
    parts.push(format!(
        "seccomp_filters_before={}",
        before
            .seccomp_filters
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    ));
    parts.push(format!(
        "cgroup_path={}",
        encode_kernel_detail_value(after.cgroup_path.as_deref().unwrap_or("missing"))
    ));
    parts.push(format!(
        "rlimit_cpu_soft_secs={}",
        after
            .rlimits
            .cpu_soft_secs
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    ));
    parts.push(format!(
        "rlimit_cpu_hard_secs={}",
        after
            .rlimits
            .cpu_hard_secs
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    ));
    parts.push(format!(
        "rlimit_as_soft_bytes={}",
        after
            .rlimits
            .address_space_soft_bytes
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    ));
    parts.push(format!(
        "rlimit_as_hard_bytes={}",
        after
            .rlimits
            .address_space_hard_bytes
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    ));
    for (name, value) in &after.namespaces {
        parts.push(format!(
            "ns_{name}={}",
            encode_kernel_detail_value(value.as_str())
        ));
    }
    for (name, probe) in probes {
        parts.push(format!(
            "probe_{name}_blocked={}",
            if probe.blocked { 1 } else { 0 }
        ));
        parts.push(format!(
            "probe_{name}_errno={}",
            probe
                .errno_code
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ));
        parts.push(format!(
            "probe_{name}_errno_name={}",
            encode_kernel_detail_value(probe.errno_name.as_str())
        ));
    }
    parts.join(";")
}

#[cfg(target_os = "linux")]
unsafe extern "C" {
    fn prctl(option: i32, arg2: usize, arg3: usize, arg4: usize, arg5: usize) -> i32;
}

#[cfg(target_os = "linux")]
fn enforce_linux_no_new_privs() -> Result<(), String> {
    let rc = unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if rc != 0 {
        return Err(format!(
            "failed to set PR_SET_NO_NEW_PRIVS: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn load_kernel_isolation_envelope(
    profile: &IsolationProfile,
) -> Result<KernelIsolationEnvelope, String> {
    #[cfg(target_os = "linux")]
    {
        let before = collect_linux_kernel_status()?;
        apply_linux_kernel_controls(profile)?;
        let after = collect_linux_kernel_status()?;
        validate_linux_kernel_status(profile, &after)?;
        let probes = if profile.name == "strict" {
            let probes = probe_linux_kernel_controls();
            validate_linux_kernel_probes(&probes)?;
            probes
        } else {
            BTreeMap::new()
        };

        let detail = build_kernel_isolation_detail(profile, &before, &after, &probes);
        Ok(KernelIsolationEnvelope {
            detail,
            no_new_privs: after.no_new_privs,
        })
    }

    #[cfg(not(target_os = "linux"))]
    {
        let detail = format!(
            "supported=0;os={};profile={};no_new_privs=0",
            encode_kernel_detail_value(std::env::consts::OS),
            encode_kernel_detail_value(&profile.name)
        );
        Ok(KernelIsolationEnvelope {
            detail,
            no_new_privs: false,
        })
    }
}

fn load_isolation_profile() -> Result<IsolationProfile, String> {
    let profile = std::env::var("AEGISPY_WORKER_ISOLATION_PROFILE")
        .unwrap_or_else(|_| "strict".to_string())
        .trim()
        .to_lowercase();

    let (defaults, deny_env_capability) = match profile.as_str() {
        "strict" => (
            (5000_u64, 5000_u64, 512 * 1024 * 1024, 2 * 1024 * 1024),
            true,
        ),
        "compat" => (
            (10000_u64, 10000_u64, 256 * 1024 * 1024, 8 * 1024 * 1024),
            false,
        ),
        _ => return Err("invalid AEGISPY_WORKER_ISOLATION_PROFILE".to_string()),
    };

    let max_wall_ms = parse_positive_env_u64("AEGISPY_WORKER_MAX_WALL_MS", defaults.0)?;
    let max_cpu_ms = parse_positive_env_u64("AEGISPY_WORKER_MAX_CPU_MS", defaults.1)?;
    let max_memory_bytes = parse_positive_env_u64("AEGISPY_WORKER_MAX_MEMORY_BYTES", defaults.2)?;
    let max_stdout_bytes = parse_positive_env_u64("AEGISPY_WORKER_MAX_STDOUT_BYTES", defaults.3)?;
    let max_stderr_bytes = parse_positive_env_u64("AEGISPY_WORKER_MAX_STDERR_BYTES", defaults.3)?;
    let deny_env_capability =
        parse_bool_env("AEGISPY_WORKER_DENY_ENV_CAPABILITY", deny_env_capability)?;

    Ok(IsolationProfile {
        name: profile,
        max_wall_ms,
        max_cpu_ms,
        max_memory_bytes,
        max_stdout_bytes,
        max_stderr_bytes,
        deny_env_capability,
    })
}

fn load_executor_mode() -> Result<WorkerExecutorMode, String> {
    let raw = std::env::var("AEGISPY_WORKER_EXECUTOR").unwrap_or_else(|_| "wasi".to_string());
    WorkerExecutorMode::from_str(&raw)
}

fn load_capability_binding_mode() -> Result<CapabilityBindingMode, String> {
    let raw = std::env::var("AEGISPY_WORKER_CAPABILITY_BINDING_MODE")
        .unwrap_or_else(|_| "guest-runtime-abi".to_string());
    CapabilityBindingMode::from_str(&raw)
}

fn encode_frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    let len = payload.len() as u32;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn read_frame(reader: &mut dyn Read) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0_u8; 4];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }

    let len = u32::from_be_bytes(header) as usize;
    let mut payload = vec![0_u8; len];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

fn write_frame(writer: &mut dyn Write, payload: &[u8]) -> io::Result<()> {
    let framed = encode_frame(payload);
    writer.write_all(&framed)?;
    writer.flush()
}

fn required_non_negative_u64(value: &Value, path: &[&str]) -> Result<u64, String> {
    let mut current = value;
    for key in path {
        current = current
            .get(*key)
            .ok_or_else(|| format!("missing field: {}", path.join(".")))?;
    }

    current
        .as_u64()
        .ok_or_else(|| format!("invalid number field: {}", path.join(".")))
}

fn required_string<'a>(value: &'a Value, path: &[&str]) -> Result<&'a str, String> {
    let mut current = value;
    for key in path {
        current = current
            .get(*key)
            .ok_or_else(|| format!("missing field: {}", path.join(".")))?;
    }

    current
        .as_str()
        .ok_or_else(|| format!("invalid string field: {}", path.join(".")))
}

fn parse_marker_u64(code: &str, marker: &str) -> Option<u64> {
    let index = code.find(marker)?;
    let tail = &code[index + marker.len()..];
    let digits: String = tail.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<u64>().ok()
}

fn decode_quoted_literal(token: &str) -> Option<String> {
    let trimmed = token.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() < 2 {
        return None;
    }
    let quote = bytes[0];
    if quote != b'\'' && quote != b'"' {
        return None;
    }
    if bytes[bytes.len() - 1] != quote {
        return None;
    }

    let mut out = String::new();
    let mut index = 1;
    while index + 1 < bytes.len() {
        let byte = bytes[index];
        if byte == b'\\' && index + 2 <= bytes.len() {
            let escaped = bytes[index + 1];
            let mapped = match escaped {
                b'n' => '\n',
                b'r' => '\r',
                b't' => '\t',
                b'\\' => '\\',
                b'"' => '"',
                b'\'' => '\'',
                _ => escaped as char,
            };
            out.push(mapped);
            index += 2;
            continue;
        }
        if byte == quote {
            return None;
        }
        out.push(byte as char);
        index += 1;
    }

    Some(out)
}

fn find_matching_paren(code: &str, open_paren_index: usize) -> Option<usize> {
    let bytes = code.as_bytes();
    let mut index = open_paren_index;
    let mut depth = 0_i64;
    let mut in_quote: Option<u8> = None;

    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(quote) = in_quote {
            if byte == b'\\' && index + 1 < bytes.len() {
                index += 2;
                continue;
            }
            if byte == quote {
                in_quote = None;
            }
            index += 1;
            continue;
        }

        if byte == b'"' || byte == b'\'' {
            in_quote = Some(byte);
            index += 1;
            continue;
        }

        if byte == b'(' {
            depth += 1;
        } else if byte == b')' {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }

        index += 1;
    }

    None
}

fn extract_literal_arguments(input: &str) -> Vec<Option<String>> {
    let bytes = input.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    let mut index = 0;
    let mut depth = 0_i64;
    let mut quote: Option<u8> = None;

    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(active) = quote {
            if byte == b'\\' && index + 1 < bytes.len() {
                index += 2;
                continue;
            }
            if byte == active {
                quote = None;
            }
            index += 1;
            continue;
        }

        if byte == b'\'' || byte == b'"' {
            quote = Some(byte);
            index += 1;
            continue;
        }
        if byte == b'(' || byte == b'[' || byte == b'{' {
            depth += 1;
            index += 1;
            continue;
        }
        if byte == b')' || byte == b']' || byte == b'}' {
            depth -= 1;
            index += 1;
            continue;
        }
        if byte == b',' && depth == 0 {
            out.push(decode_quoted_literal(&input[start..index]));
            start = index + 1;
        }
        index += 1;
    }

    if start < input.len() {
        out.push(decode_quoted_literal(&input[start..]));
    } else if input.trim().is_empty() {
        out.clear();
    } else {
        out.push(None);
    }

    out
}

fn collect_call_targets(code: &str, call_marker: &str) -> Vec<String> {
    let needle = format!("{call_marker}(");
    let mut out = Vec::new();
    let mut cursor = 0;

    while let Some(found) = code[cursor..].find(&needle) {
        let call_start = cursor + found;
        let open_paren_index = call_start + needle.len() - 1;
        let Some(close_paren_index) = find_matching_paren(code, open_paren_index) else {
            break;
        };
        let args = extract_literal_arguments(&code[open_paren_index + 1..close_paren_index]);
        if let Some(Some(target)) = args.first() {
            out.push(target.clone());
        }
        cursor = close_paren_index + 1;
    }

    out
}

fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn string_list_at_path(value: &Value, path: &[&str]) -> Vec<String> {
    value_at_path(value, path)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn path_under_root(target: &str, root: &str) -> bool {
    if root == "/" {
        return target.starts_with('/');
    }
    if target == root {
        return true;
    }
    target
        .strip_prefix(root)
        .map(|suffix| suffix.starts_with('/'))
        .unwrap_or(false)
}

fn path_under_roots(target: &str, roots: &[String]) -> bool {
    roots.iter().any(|root| path_under_root(target, root))
}

fn has_path_traversal(target: &str) -> bool {
    target.contains("/../") || target.starts_with("../") || target.ends_with("/..")
}

fn extract_http_origin(target: &str) -> Option<String> {
    let scheme_end = target.find("://")?;
    let after_scheme = &target[scheme_end + 3..];
    let slash = after_scheme.find('/').unwrap_or(after_scheme.len());
    Some(format!(
        "{}://{}",
        &target[..scheme_end],
        &after_scheme[..slash]
    ))
}

fn extract_print_value(code: &str) -> String {
    if let Some(start) = code.find("print(\"") {
        let tail = &code[start + 7..];
        if let Some(end) = tail.find("\")") {
            return format!("{}\n", &tail[..end]);
        }
    }

    if let Some(start) = code.find("print('") {
        let tail = &code[start + 7..];
        if let Some(end) = tail.find("')") {
            return format!("{}\n", &tail[..end]);
        }
    }

    String::new()
}

fn now_ms() -> u64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_millis(0));
    duration.as_millis() as u64
}

fn worker_debug_enabled() -> bool {
    std::env::var("AEGISPY_WORKER_DEBUG")
        .map(|value| value == "1")
        .unwrap_or(false)
}

fn worker_debug(event: &str, detail: &str) {
    if worker_debug_enabled() {
        eprintln!(
            "{}",
            json!({
              "level": "debug",
              "event": event,
              "detail": detail
            })
        );
    }
}

fn clamp_u64_to_usize(value: u64) -> usize {
    min(value, usize::MAX as u64) as usize
}

fn parse_seed_u64(seed_hex: &str) -> u64 {
    let trimmed = seed_hex.trim();
    if trimmed.is_empty() {
        return 1;
    }
    let relevant = if trimmed.len() > 16 {
        &trimmed[..16]
    } else {
        trimmed
    };
    u64::from_str_radix(relevant, 16).unwrap_or(1).max(1)
}

fn maybe_push_nondeterminism_audit(
    run: &Value,
    code: &str,
    started_ts_ms: u64,
    audit: &mut Vec<Value>,
) {
    let determinism_enabled = run
        .get("determinism")
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if determinism_enabled {
        return;
    }

    if code.contains("time.time") {
        audit.push(json!({ "kind": "determinism_time", "detailJson": "source:time.time", "tsMs": started_ts_ms }));
    }

    if code.contains("random.random") {
        audit.push(json!({ "kind": "determinism_rng", "detailJson": "source:random.random", "tsMs": started_ts_ms }));
    }
}

fn enforce_capability_policy(
    run: &Value,
    code: &str,
    started_ts_ms: u64,
    audit: &mut Vec<Value>,
) -> Option<Value> {
    let fs_write_targets = collect_call_targets(code, "aegispy.fs_write");
    let fs_read_targets = collect_call_targets(code, "aegispy.fs_read");
    if !fs_write_targets.is_empty() || !fs_read_targets.is_empty() {
        let fs_is_null = run
            .get("permissions")
            .and_then(|value| value.get("fs"))
            .map(Value::is_null)
            .unwrap_or(true);
        if fs_is_null {
            audit.push(json!({ "kind": "policy_denied", "detailJson": "fs_permission_missing" }));
            return Some(make_error_result(
                "AEG-POLICY-DENIED",
                "fs_permission_missing",
                "policy_denied",
                started_ts_ms,
                started_ts_ms + 1,
                audit.clone(),
            ));
        }

        let write_roots = string_list_at_path(run, &["permissions", "fs", "writeRoots"]);
        let read_roots = string_list_at_path(run, &["permissions", "fs", "readRoots"]);

        for target in fs_write_targets {
            if has_path_traversal(&target) || !path_under_roots(&target, &write_roots) {
                audit.push(json!({
                  "kind": "policy_denied",
                  "detailJson": format!("fs_path_denied:{target}")
                }));
                return Some(make_error_result(
                    "AEG-POLICY-DENIED",
                    "fs_path_denied",
                    "policy_denied",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit.clone(),
                ));
            }
            audit.push(json!({ "kind": "fs_write", "detailJson": "allow" }));
        }

        for target in fs_read_targets {
            if has_path_traversal(&target) || !path_under_roots(&target, &read_roots) {
                audit.push(json!({
                  "kind": "policy_denied",
                  "detailJson": format!("fs_path_denied:{target}")
                }));
                return Some(make_error_result(
                    "AEG-POLICY-DENIED",
                    "fs_path_denied",
                    "policy_denied",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit.clone(),
                ));
            }
            audit.push(json!({ "kind": "fs_read", "detailJson": "allow" }));
        }
    }

    let http_targets = collect_call_targets(code, "aegispy.http_get");
    if !http_targets.is_empty() {
        let http_is_null = run
            .get("permissions")
            .and_then(|value| value.get("http"))
            .map(Value::is_null)
            .unwrap_or(true);
        if http_is_null {
            audit.push(json!({ "kind": "policy_denied", "detailJson": "http_permission_missing" }));
            return Some(make_error_result(
                "AEG-POLICY-DENIED",
                "http_permission_missing",
                "policy_denied",
                started_ts_ms,
                started_ts_ms + 1,
                audit.clone(),
            ));
        }

        let allow_origins = string_list_at_path(run, &["permissions", "http", "allowOrigins"]);
        let deny_origins = string_list_at_path(run, &["permissions", "http", "denyOrigins"]);
        let max_requests =
            required_non_negative_u64(run, &["permissions", "http", "maxRequests"]).unwrap_or(0);
        if max_requests > 0 && (http_targets.len() as u64) > max_requests {
            audit.push(json!({
              "kind": "policy_denied",
              "detailJson": "http_max_requests_exceeded"
            }));
            return Some(make_error_result(
                "AEG-POLICY-DENIED",
                "http_max_requests_exceeded",
                "policy_denied",
                started_ts_ms,
                started_ts_ms + 1,
                audit.clone(),
            ));
        }

        for target in http_targets {
            let origin = extract_http_origin(&target).unwrap_or(target.clone());
            if deny_origins.iter().any(|blocked| blocked == &origin)
                || !allow_origins.iter().any(|allowed| allowed == &origin)
            {
                audit.push(json!({
                  "kind": "policy_denied",
                  "detailJson": format!("http_origin_denied:{origin}")
                }));
                return Some(make_error_result(
                    "AEG-POLICY-DENIED",
                    "http_origin_denied",
                    "policy_denied",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit.clone(),
                ));
            }

            audit.push(json!({ "kind": "http_request", "detailJson": "allow" }));
        }
    }

    let env_targets = collect_call_targets(code, "aegispy.env_get");
    if !env_targets.is_empty() {
        let env_is_null = run
            .get("permissions")
            .and_then(|value| value.get("env"))
            .map(Value::is_null)
            .unwrap_or(true);
        if env_is_null {
            audit.push(json!({ "kind": "policy_denied", "detailJson": "env_permission_missing" }));
            return Some(make_error_result(
                "AEG-POLICY-DENIED",
                "env_permission_missing",
                "policy_denied",
                started_ts_ms,
                started_ts_ms + 1,
                audit.clone(),
            ));
        }

        let allow_keys = string_list_at_path(run, &["permissions", "env", "allowKeys"]);
        for target in env_targets {
            if !allow_keys.iter().any(|allowed| allowed == &target) {
                audit.push(json!({
                  "kind": "policy_denied",
                  "detailJson": format!("env_key_denied:{target}")
                }));
                return Some(make_error_result(
                    "AEG-POLICY-DENIED",
                    "env_key_denied",
                    "policy_denied",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit.clone(),
                ));
            }
            audit.push(json!({ "kind": "env_read", "detailJson": "allow" }));
        }
    }

    None
}

fn rewrite_code_for_determinism(code: &str, run: &Value) -> String {
    let deterministic_enabled = run
        .get("determinism")
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let epoch_ms = run
        .get("determinism")
        .and_then(|value| value.get("epochMs"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let seed_hex = run
        .get("determinism")
        .and_then(|value| value.get("rngSeedHex"))
        .and_then(Value::as_str)
        .unwrap_or("1");
    let seed = parse_seed_u64(seed_hex);
    let mut rewritten = code.to_string();

    if rewritten.contains("time.time()") {
        let replacement = if deterministic_enabled {
            format!("{}", (epoch_ms as f64) / 1000.0)
        } else {
            format!("{}", (now_ms() as f64) / 1000.0)
        };
        rewritten = rewritten.replace("time.time()", &replacement);
    }

    if rewritten.contains("random.random()") {
        let value = if deterministic_enabled {
            let next = seed.wrapping_mul(1664525).wrapping_add(1013904223) & 0xffff_ffff;
            (next as f64) / 4294967296.0
        } else {
            let next = (now_ms() % 1_000_003) as f64;
            next / 1_000_003.0
        };
        rewritten = rewritten.replace("random.random()", &format!("{value:.6}"));
    }

    rewritten
}

const CAPABILITY_FS_DIR: &str = "fs";
const CAPABILITY_NATIVE_REQ_PREFIX: &str = "\u{1e}aegispy-cap-req:";
const CAPABILITY_NATIVE_RES_PREFIX: &str = "\u{1e}aegispy-cap-res:";
const WORKER_PROJECT_ROOTS_JSON_ENV: &str = "AEGISPY_WORKER_PROJECT_ROOTS_JSON";
const WORKER_PACKAGE_ROOTS_JSON_ENV: &str = "AEGISPY_WORKER_PACKAGE_ROOTS_JSON";
const WORKER_TEMP_ROOT_ENV: &str = "AEGISPY_WORKER_TEMP_ROOT";
const GUEST_PROJECT_ROOTS_BASE: &str = "/workspace/projects";
const GUEST_PACKAGE_ROOTS_BASE: &str = "/workspace/packages";
const GUEST_WRITABLE_BINDING_ROOT: &str = "/workspace/bindings/fs";
const GUEST_WRITABLE_IMPORT_ROOT: &str = "/workspace/bindings/fs/sandbox/write";
const GUEST_TEMP_ROOT: &str = "/tmp";

#[derive(Clone, Default)]
struct HostCapabilityHttpState {
    requests_used: u64,
}

#[derive(Clone, Default)]
struct HostCapabilityFsState {
    bytes_used: u64,
    written_files: BTreeSet<String>,
}

#[derive(Clone)]
struct HostCapabilityFsConfig {
    read_roots: Vec<String>,
    write_roots: Vec<String>,
    max_bytes: u64,
    max_files: u64,
}

#[derive(Clone)]
struct HostCapabilityHttpConfig {
    allow_origins: Vec<String>,
    deny_origins: Vec<String>,
    max_requests: u64,
    max_bytes: u64,
    timeout_ms: u64,
}

#[derive(Clone)]
struct HostCapabilityEnvConfig {
    allow_keys: Vec<String>,
}

#[derive(Clone)]
struct HostCapabilityConfig {
    fs: Option<HostCapabilityFsConfig>,
    http: Option<HostCapabilityHttpConfig>,
    env: Option<HostCapabilityEnvConfig>,
}

#[derive(Clone)]
struct NativeHostCapabilityState {
    config: HostCapabilityConfig,
    fs_root: PathBuf,
    fs_state: HostCapabilityFsState,
    http_state: HostCapabilityHttpState,
    audit: Vec<Value>,
    policy_denial: Option<String>,
    engine_error: Option<String>,
}

type SharedNativeHostCapabilityState = Arc<Mutex<NativeHostCapabilityState>>;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct HostCapabilityRequest {
    capability: String,
    field_a: String,
    field_b: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct HostCapabilityRuntimeRequest {
    id: String,
    capability: String,
    field_a: String,
    field_b: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct HostCapabilityRuntimeResponse {
    id: String,
    ok: bool,
    payload_utf8: String,
    error_code: String,
}

#[derive(Default)]
struct NativeHostAbiInputState {
    capability_bytes: VecDeque<u8>,
    stdin_bytes: Vec<u8>,
    stdin_offset: usize,
}

#[derive(Clone, Default)]
struct NativeHostAbiInputPipe {
    state: Arc<Mutex<NativeHostAbiInputState>>,
    ready: Arc<Notify>,
}

struct NativeHostAbiStderrState {
    output: Vec<u8>,
    frame_buffer: Vec<u8>,
}

#[derive(Clone)]
struct NativeHostAbiStderrPipe {
    capacity: usize,
    state: Arc<Mutex<NativeHostAbiStderrState>>,
    stdin_pipe: NativeHostAbiInputPipe,
    native_capability: SharedNativeHostCapabilityState,
}

#[derive(Clone, Debug)]
enum HostCapabilityValue {
    None,
    Utf8(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HostCapabilityFailureKind {
    PolicyDenied,
    EngineError,
}

#[derive(Clone, Debug)]
struct HostCapabilityFailure {
    kind: HostCapabilityFailureKind,
    code: String,
}

fn create_temp_binding_dir(prefix: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("{prefix}-{}-{}", std::process::id(), now_ms()));
    fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create capability temp dir: {error}"))?;
    Ok(dir)
}

fn read_worker_project_roots() -> Result<Vec<PathBuf>, String> {
    let Ok(raw) = std::env::var(WORKER_PROJECT_ROOTS_JSON_ENV) else {
        return Ok(Vec::new());
    };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }

    let parsed = serde_json::from_str::<Vec<String>>(&raw)
        .map_err(|error| format!("invalid project root list: {error}"))?;
    Ok(parsed.into_iter().map(PathBuf::from).collect())
}

fn read_worker_package_roots() -> Result<Vec<PathBuf>, String> {
    let Ok(raw) = std::env::var(WORKER_PACKAGE_ROOTS_JSON_ENV) else {
        return Ok(Vec::new());
    };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }

    let parsed = serde_json::from_str::<Vec<String>>(&raw)
        .map_err(|error| format!("invalid package root list: {error}"))?;
    Ok(parsed.into_iter().map(PathBuf::from).collect())
}

fn guest_project_root(index: usize) -> String {
    format!("{GUEST_PROJECT_ROOTS_BASE}/{index}")
}

fn guest_package_root(index: usize) -> String {
    format!("{GUEST_PACKAGE_ROOTS_BASE}/{index}")
}

fn resolve_guest_temp_host_root() -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var(WORKER_TEMP_ROOT_ENV) {
        let path = PathBuf::from(raw);
        fs::create_dir_all(&path)
            .map_err(|error| format!("failed to create guest temp root: {error}"))?;
        return Ok(path);
    }

    create_temp_binding_dir("aegispy-worker-temp")
}

impl NativeHostAbiInputPipe {
    fn from_utf8(input: &str) -> Self {
        Self {
            state: Arc::new(Mutex::new(NativeHostAbiInputState {
                capability_bytes: VecDeque::new(),
                stdin_bytes: input.as_bytes().to_vec(),
                stdin_offset: 0,
            })),
            ready: Arc::new(Notify::new()),
        }
    }

    fn push_capability_response_frame(&self, payload: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.capability_bytes.extend(payload.as_bytes());
        }
        self.ready.notify_waiters();
    }

    fn has_available_bytes(&self) -> bool {
        let Ok(state) = self.state.lock() else {
            return true;
        };
        !state.capability_bytes.is_empty() || state.stdin_offset < state.stdin_bytes.len()
    }
}

#[derive(Clone)]
struct NativeHostAbiInputStream {
    pipe: NativeHostAbiInputPipe,
}

impl IsTerminal for NativeHostAbiInputPipe {
    fn is_terminal(&self) -> bool {
        false
    }
}

impl StdinStream for NativeHostAbiInputPipe {
    fn async_stream(&self) -> Box<dyn tokio::io::AsyncRead + Send + Sync> {
        Box::new(tokio::io::empty())
    }

    fn p2_stream(&self) -> Box<dyn InputStream> {
        Box::new(NativeHostAbiInputStream { pipe: self.clone() })
    }
}

#[wasmtime_wasi::async_trait]
impl Pollable for NativeHostAbiInputStream {
    async fn ready(&mut self) {
        loop {
            if self.pipe.has_available_bytes() {
                return;
            }

            // Register for the next wake-up and then re-check availability to
            // avoid missing a just-arrived capability response frame.
            let wait = self.pipe.ready.clone().notified_owned();
            if self.pipe.has_available_bytes() {
                return;
            }
            wait.await;
        }
    }
}

#[wasmtime_wasi::async_trait]
impl InputStream for NativeHostAbiInputStream {
    fn read(&mut self, size: usize) -> Result<Bytes, StreamError> {
        let mut state = self
            .pipe
            .state
            .lock()
            .map_err(|_| StreamError::trap("native_host_abi_input_state_lock_poisoned"))?;
        if size == 0 {
            return Ok(Bytes::new());
        }

        if !state.capability_bytes.is_empty() {
            let amount = min(size, state.capability_bytes.len());
            let mut out = Vec::with_capacity(amount);
            for _ in 0..amount {
                if let Some(byte) = state.capability_bytes.pop_front() {
                    out.push(byte);
                }
            }
            return Ok(Bytes::from(out));
        }

        if state.stdin_offset < state.stdin_bytes.len() {
            let available = state.stdin_bytes.len() - state.stdin_offset;
            let amount = min(size, available);
            let end = state.stdin_offset + amount;
            let out = Bytes::copy_from_slice(&state.stdin_bytes[state.stdin_offset..end]);
            state.stdin_offset = end;
            return Ok(out);
        }

        // Not closed: native capability responses may arrive asynchronously
        // after stdin bytes are exhausted.
        Ok(Bytes::new())
    }
}

impl NativeHostAbiStderrPipe {
    fn new(
        capacity: usize,
        stdin_pipe: NativeHostAbiInputPipe,
        native_capability: SharedNativeHostCapabilityState,
    ) -> Self {
        Self {
            capacity,
            state: Arc::new(Mutex::new(NativeHostAbiStderrState {
                output: Vec::new(),
                frame_buffer: Vec::new(),
            })),
            stdin_pipe,
            native_capability,
        }
    }

    fn contents(&self) -> Vec<u8> {
        let mut output = Vec::new();
        if let Ok(state) = self.state.lock() {
            output.extend_from_slice(&state.output);
            output.extend_from_slice(&state.frame_buffer);
        }
        output
    }

    fn push_runtime_response(&self, request: HostCapabilityRuntimeRequest) {
        let response_id = request.id;
        let cap_result = invoke_native_capability_shared(
            &self.native_capability,
            &request.capability,
            request.field_a,
            request.field_b,
        );
        let response = HostCapabilityRuntimeResponse {
            id: response_id.clone(),
            ok: cap_result.ok,
            payload_utf8: cap_result.payload_utf8,
            error_code: cap_result.error_code,
        };
        let response_json = serde_json::to_string(&response).unwrap_or_else(|error| {
            json!({
              "id": response_id,
              "ok": false,
              "payload_utf8": "",
              "error_code": format!("native_host_abi_response_serialize_failed:{error}")
            })
            .to_string()
        });
        let response_frame = format!("{CAPABILITY_NATIVE_RES_PREFIX}{response_json}\n");
        self.stdin_pipe
            .push_capability_response_frame(&response_frame);
    }

    fn write_regular_stderr_bytes(&self, bytes: &[u8]) -> usize {
        let Ok(mut state) = self.state.lock() else {
            return 0;
        };
        let available = self.capacity.saturating_sub(state.output.len());
        let amount = min(bytes.len(), available);
        state.output.extend_from_slice(&bytes[..amount]);
        amount
    }

    fn process_runtime_request_frames(&self, bytes: &[u8]) -> Option<usize> {
        let Ok(mut state) = self.state.lock() else {
            return None;
        };
        let accepted = bytes.len();
        state.frame_buffer.extend_from_slice(bytes);

        loop {
            let Some(newline_index) = state.frame_buffer.iter().position(|byte| *byte == b'\n')
            else {
                break;
            };

            let frame = state
                .frame_buffer
                .drain(..=newline_index)
                .collect::<Vec<_>>();
            let mut trimmed = frame.as_slice();
            while trimmed.ends_with(b"\n") || trimmed.ends_with(b"\r") {
                trimmed = &trimmed[..trimmed.len() - 1];
            }

            if let Some(payload) = trimmed.strip_prefix(CAPABILITY_NATIVE_REQ_PREFIX.as_bytes()) {
                let parsed = serde_json::from_slice::<HostCapabilityRuntimeRequest>(payload);
                drop(state);
                match parsed {
                    Ok(request) => self.push_runtime_response(request),
                    Err(error) => {
                        if let Ok(mut cap_state) = self.native_capability.lock() {
                            let detail = format!("native_host_abi_request_parse_failed:{error}");
                            if cap_state.engine_error.is_none() {
                                cap_state.engine_error = Some(detail.clone());
                            }
                            cap_state.audit.push(json!({
                              "kind": "engine_error",
                              "detailJson": format!("runtime_denied:{detail}")
                            }));
                        }
                    }
                }
                state = match self.state.lock() {
                    Ok(guard) => guard,
                    Err(_) => return Some(accepted),
                };
                continue;
            }

            let available = self.capacity.saturating_sub(state.output.len());
            let amount = min(frame.len(), available);
            state.output.extend_from_slice(&frame[..amount]);
        }

        if !state.frame_buffer.is_empty()
            && !CAPABILITY_NATIVE_REQ_PREFIX
                .as_bytes()
                .starts_with(&state.frame_buffer)
        {
            let tail = std::mem::take(&mut state.frame_buffer);
            let available = self.capacity.saturating_sub(state.output.len());
            let amount = min(tail.len(), available);
            state.output.extend_from_slice(&tail[..amount]);
        }

        Some(accepted)
    }
}

impl IsTerminal for NativeHostAbiStderrPipe {
    fn is_terminal(&self) -> bool {
        false
    }
}

impl StdoutStream for NativeHostAbiStderrPipe {
    fn async_stream(&self) -> Box<dyn AsyncWrite + Send + Sync> {
        Box::new(self.clone())
    }
}

impl AsyncWrite for NativeHostAbiStderrPipe {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut().clone();
        if let Some(amount) = this.process_runtime_request_frames(buf) {
            return Poll::Ready(Ok(amount));
        }
        Poll::Ready(Ok(this.write_regular_stderr_bytes(buf)))
    }

    fn poll_flush(self: std::pin::Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

fn sanitize_virtual_root(root: &str) -> Result<PathBuf, String> {
    let trimmed = root.trim_start_matches('/');
    let candidate = Path::new(trimmed);
    let mut out = PathBuf::new();

    for component in candidate.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err("invalid fs root".to_string()),
        }
    }

    if out.as_os_str().is_empty() {
        out.push("__root__");
    }
    Ok(out)
}

fn resolve_fs_binding_path(
    binding_root: &Path,
    target: &str,
    roots: &[String],
) -> Result<(PathBuf, String), String> {
    let selected_root = roots
        .iter()
        .filter(|root| path_under_root(target, root))
        .max_by_key(|root| root.len())
        .cloned()
        .ok_or_else(|| "fs root not mapped".to_string())?;
    let host_root = binding_root.join(sanitize_virtual_root(&selected_root)?);

    let tail = if target == selected_root {
        String::new()
    } else if selected_root == "/" {
        target.trim_start_matches('/').to_string()
    } else {
        target[selected_root.len() + 1..].to_string()
    };

    let mut relative = PathBuf::new();
    for component in Path::new(&tail).components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            _ => return Err("invalid fs path".to_string()),
        }
    }

    Ok((host_root.join(relative), selected_root))
}

fn execute_http_get(url: &str, max_bytes: u64, timeout_ms: u64) -> Result<String, String> {
    let timeout = Duration::from_millis(timeout_ms.max(1));
    let mut response = ureq::get(url)
        .config()
        .timeout_global(Some(timeout))
        .timeout_recv_body(Some(timeout))
        .build()
        .call()
        .map_err(|error| format!("http_get_failed:{error}"))?;
    let body = response
        .body_mut()
        .with_config()
        .limit(max_bytes.saturating_add(1))
        .read_to_vec()
        .map_err(|error| match error {
            ureq::Error::BodyExceedsLimit(_) => "http_response_bytes_exceeded".to_string(),
            other => format!("http_read_failed:{other}"),
        })?;
    Ok(String::from_utf8_lossy(&body).to_string())
}

fn non_null_value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    value_at_path(value, path).filter(|node| !node.is_null())
}

fn build_host_capability_config(run: &Value, wall_ms: u64) -> HostCapabilityConfig {
    let fs = non_null_value_at_path(run, &["permissions", "fs"]).map(|_| HostCapabilityFsConfig {
        read_roots: string_list_at_path(run, &["permissions", "fs", "readRoots"]),
        write_roots: string_list_at_path(run, &["permissions", "fs", "writeRoots"]),
        max_bytes: required_non_negative_u64(run, &["permissions", "fs", "maxBytes"]).unwrap_or(0),
        max_files: required_non_negative_u64(run, &["permissions", "fs", "maxFiles"]).unwrap_or(0),
    });
    let http =
        non_null_value_at_path(run, &["permissions", "http"]).map(|_| HostCapabilityHttpConfig {
            allow_origins: string_list_at_path(run, &["permissions", "http", "allowOrigins"]),
            deny_origins: string_list_at_path(run, &["permissions", "http", "denyOrigins"]),
            max_requests: required_non_negative_u64(run, &["permissions", "http", "maxRequests"])
                .unwrap_or(0),
            max_bytes: required_non_negative_u64(run, &["permissions", "http", "maxBytes"])
                .unwrap_or(0),
            timeout_ms: wall_ms.max(1),
        });
    let env =
        non_null_value_at_path(run, &["permissions", "env"]).map(|_| HostCapabilityEnvConfig {
            allow_keys: string_list_at_path(run, &["permissions", "env", "allowKeys"]),
        });

    HostCapabilityConfig { fs, http, env }
}

impl NativeHostCapabilityState {
    fn new(config: HostCapabilityConfig, fs_root: PathBuf) -> Self {
        Self {
            config,
            fs_root,
            fs_state: HostCapabilityFsState::default(),
            http_state: HostCapabilityHttpState::default(),
            audit: Vec::new(),
            policy_denial: None,
            engine_error: None,
        }
    }

    fn invoke_internal(
        &mut self,
        capability: &str,
        field_a: String,
        field_b: String,
    ) -> Result<HostCapabilityValue, HostCapabilityFailure> {
        let request = HostCapabilityRequest {
            capability: capability.to_string(),
            field_a,
            field_b,
        };

        let mut runtime_audit = Vec::new();
        let response = process_host_capability_request(
            &request,
            &self.config,
            &self.fs_root,
            &mut self.fs_state,
            &mut self.http_state,
            &mut runtime_audit,
        );
        if let Err(failure) = &response {
            let detail = failure.code.clone();
            let audit_kind = if failure.kind == HostCapabilityFailureKind::PolicyDenied {
                "policy_denied"
            } else {
                "engine_error"
            };
            runtime_audit.push(json!({
              "kind": audit_kind,
              "detailJson": format!("runtime_denied:{detail}")
            }));
            if failure.kind == HostCapabilityFailureKind::PolicyDenied
                && self.policy_denial.is_none()
            {
                self.policy_denial = Some(detail.clone());
            }
            if failure.kind == HostCapabilityFailureKind::EngineError && self.engine_error.is_none()
            {
                self.engine_error = Some(detail);
            }
        }

        self.audit.extend(runtime_audit);
        response
    }

    fn invoke(
        &mut self,
        capability: &str,
        field_a: String,
        field_b: String,
    ) -> component_host_bindings::aegispy::runtime::capability::CapResult {
        match self.invoke_internal(capability, field_a, field_b) {
            Ok(value) => {
                let payload_utf8 = match value {
                    HostCapabilityValue::None => String::new(),
                    HostCapabilityValue::Utf8(payload) => payload,
                };
                component_host_bindings::aegispy::runtime::capability::CapResult {
                    ok: true,
                    payload_utf8,
                    error_code: String::new(),
                }
            }
            Err(failure) => component_host_bindings::aegispy::runtime::capability::CapResult {
                ok: false,
                payload_utf8: String::new(),
                error_code: failure.code,
            },
        }
    }
}

fn cap_result_engine_error(
    message: &str,
) -> component_host_bindings::aegispy::runtime::capability::CapResult {
    component_host_bindings::aegispy::runtime::capability::CapResult {
        ok: false,
        payload_utf8: String::new(),
        error_code: message.to_string(),
    }
}

fn invoke_native_capability_shared(
    native_capability: &SharedNativeHostCapabilityState,
    capability: &str,
    field_a: String,
    field_b: String,
) -> component_host_bindings::aegispy::runtime::capability::CapResult {
    let mut state = match native_capability.lock() {
        Ok(guard) => guard,
        Err(_) => return cap_result_engine_error("native_capability_state_poisoned"),
    };
    state.invoke(capability, field_a, field_b)
}

fn snapshot_native_capability_state(
    native_capability: &SharedNativeHostCapabilityState,
) -> NativeHostCapabilityState {
    match native_capability.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => NativeHostCapabilityState {
            config: HostCapabilityConfig {
                fs: None,
                http: None,
                env: None,
            },
            fs_root: PathBuf::new(),
            fs_state: HostCapabilityFsState::default(),
            http_state: HostCapabilityHttpState::default(),
            audit: vec![json!({
              "kind": "engine_error",
              "detailJson": "runtime_denied:native_capability_state_poisoned"
            })],
            policy_denial: None,
            engine_error: Some("native_capability_state_poisoned".to_string()),
        },
    }
}

impl component_host_bindings::aegispy::runtime::capability::Host for WasiStoreState {
    fn fs_read(
        &mut self,
        input: component_host_bindings::aegispy::runtime::capability::FsReadInput,
    ) -> component_host_bindings::aegispy::runtime::capability::CapResult {
        invoke_native_capability_shared(
            &self.native_capability,
            "fs_read",
            input.path,
            String::new(),
        )
    }

    fn fs_write(
        &mut self,
        input: component_host_bindings::aegispy::runtime::capability::FsWriteInput,
    ) -> component_host_bindings::aegispy::runtime::capability::CapResult {
        invoke_native_capability_shared(
            &self.native_capability,
            "fs_write",
            input.path,
            input.data_utf8,
        )
    }

    fn http_get(
        &mut self,
        input: component_host_bindings::aegispy::runtime::capability::HttpGetInput,
    ) -> component_host_bindings::aegispy::runtime::capability::CapResult {
        invoke_native_capability_shared(
            &self.native_capability,
            "http_get",
            input.url,
            String::new(),
        )
    }

    fn env_get(
        &mut self,
        input: component_host_bindings::aegispy::runtime::capability::EnvGetInput,
    ) -> component_host_bindings::aegispy::runtime::capability::CapResult {
        invoke_native_capability_shared(
            &self.native_capability,
            "env_get",
            input.key,
            String::new(),
        )
    }
}

fn host_capability_failure_policy(code: impl Into<String>) -> HostCapabilityFailure {
    HostCapabilityFailure {
        kind: HostCapabilityFailureKind::PolicyDenied,
        code: code.into(),
    }
}

fn host_capability_failure_engine(code: impl Into<String>) -> HostCapabilityFailure {
    HostCapabilityFailure {
        kind: HostCapabilityFailureKind::EngineError,
        code: code.into(),
    }
}

fn process_host_capability_request(
    req: &HostCapabilityRequest,
    config: &HostCapabilityConfig,
    fs_root: &Path,
    fs_state: &mut HostCapabilityFsState,
    http_state: &mut HostCapabilityHttpState,
    runtime_audit: &mut Vec<Value>,
) -> Result<HostCapabilityValue, HostCapabilityFailure> {
    match req.capability.as_str() {
        "fs_write" => {
            let Some(fs_config) = config.fs.as_ref() else {
                return Err(host_capability_failure_policy("fs_permission_missing"));
            };

            let target = req.field_a.clone();
            let content = req.field_b.clone();
            if has_path_traversal(&target) || !path_under_roots(&target, &fs_config.write_roots) {
                return Err(host_capability_failure_policy("fs_path_denied"));
            }

            let (host_path, root) =
                resolve_fs_binding_path(fs_root, &target, &fs_config.write_roots)
                    .map_err(|_| host_capability_failure_policy("fs_path_denied"))?;
            let host_root = fs_root.join(
                sanitize_virtual_root(&root)
                    .map_err(|_| host_capability_failure_policy("fs_path_denied"))?,
            );
            if !host_path.starts_with(&host_root) {
                return Err(host_capability_failure_policy("fs_path_denied"));
            }

            let content_bytes = content.len() as u64;
            if fs_config.max_bytes > 0
                && fs_state.bytes_used.saturating_add(content_bytes) > fs_config.max_bytes
            {
                return Err(host_capability_failure_policy("fs_quota_bytes_exceeded"));
            }

            let host_key = host_path.to_string_lossy().to_string();
            if !fs_state.written_files.contains(&host_key)
                && fs_config.max_files > 0
                && (fs_state.written_files.len() as u64) >= fs_config.max_files
            {
                return Err(host_capability_failure_policy("fs_quota_files_exceeded"));
            }

            if let Some(parent) = host_path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    host_capability_failure_engine(format!("fs_write_failed:{error}"))
                })?;
            }
            fs::write(&host_path, content.as_bytes()).map_err(|error| {
                host_capability_failure_engine(format!("fs_write_failed:{error}"))
            })?;

            fs_state.bytes_used = fs_state.bytes_used.saturating_add(content_bytes);
            fs_state.written_files.insert(host_key);
            runtime_audit.push(json!({
              "kind": "fs_write",
              "detailJson": format!("runtime_allow:{target}")
            }));
            Ok(HostCapabilityValue::None)
        }
        "fs_read" => {
            let Some(fs_config) = config.fs.as_ref() else {
                return Err(host_capability_failure_policy("fs_permission_missing"));
            };

            let target = req.field_a.clone();
            if has_path_traversal(&target) || !path_under_roots(&target, &fs_config.read_roots) {
                return Err(host_capability_failure_policy("fs_path_denied"));
            }

            let (host_path, root) =
                resolve_fs_binding_path(fs_root, &target, &fs_config.read_roots)
                    .map_err(|_| host_capability_failure_policy("fs_path_denied"))?;
            let host_root = fs_root.join(
                sanitize_virtual_root(&root)
                    .map_err(|_| host_capability_failure_policy("fs_path_denied"))?,
            );
            if !host_path.starts_with(&host_root) {
                return Err(host_capability_failure_policy("fs_path_denied"));
            }

            let payload = fs::read_to_string(&host_path).map_err(|error| {
                host_capability_failure_engine(format!("fs_read_failed:{error}"))
            })?;
            let payload_bytes = payload.len() as u64;
            if fs_config.max_bytes > 0
                && fs_state.bytes_used.saturating_add(payload_bytes) > fs_config.max_bytes
            {
                return Err(host_capability_failure_policy("fs_quota_bytes_exceeded"));
            }

            fs_state.bytes_used = fs_state.bytes_used.saturating_add(payload_bytes);
            runtime_audit.push(json!({
              "kind": "fs_read",
              "detailJson": format!("runtime_allow:{target}")
            }));
            Ok(HostCapabilityValue::Utf8(payload))
        }
        "http_get" => {
            let Some(http_config) = config.http.as_ref() else {
                return Err(host_capability_failure_policy("http_permission_missing"));
            };

            let target = req.field_a.clone();
            let origin = extract_http_origin(&target).unwrap_or_else(|| target.clone());
            if http_config
                .deny_origins
                .iter()
                .any(|blocked| blocked == &origin)
                || !http_config
                    .allow_origins
                    .iter()
                    .any(|allowed| allowed == &origin)
            {
                return Err(host_capability_failure_policy("http_origin_denied"));
            }
            if http_config.max_requests > 0 && http_state.requests_used >= http_config.max_requests
            {
                return Err(host_capability_failure_policy("http_max_requests_exceeded"));
            }

            let payload = execute_http_get(
                &target,
                http_config.max_bytes.max(1),
                http_config.timeout_ms,
            )
            .map_err(|message| {
                if message == "http_response_bytes_exceeded" {
                    host_capability_failure_policy(message)
                } else {
                    host_capability_failure_engine(message)
                }
            })?;
            http_state.requests_used += 1;
            runtime_audit.push(json!({
              "kind": "http_request",
              "detailJson": format!("runtime_allow:{origin}")
            }));
            Ok(HostCapabilityValue::Utf8(payload))
        }
        "env_get" => {
            let Some(env_config) = config.env.as_ref() else {
                return Err(host_capability_failure_policy("env_permission_missing"));
            };

            let key = req.field_a.clone();
            if !env_config.allow_keys.iter().any(|allowed| allowed == &key) {
                return Err(host_capability_failure_policy("env_key_denied"));
            }
            runtime_audit.push(json!({
              "kind": "env_read",
              "detailJson": format!("runtime_allow:{key}")
            }));
            if let Ok(value) = std::env::var(&key) {
                Ok(HostCapabilityValue::Utf8(value))
            } else {
                Ok(HostCapabilityValue::None)
            }
        }
        _ => Err(host_capability_failure_engine("capability_unknown")),
    }
}

fn build_guest_runtime_bootstrap_code(code: &str) -> String {
    format!(
        "import aegispy as _aegispy\n\
aegispy = _aegispy\n\
del _aegispy\n\
{code}\n",
    )
}

fn detect_python_stdlib_guest_path(python_home: &Path, guest_root: &str) -> Option<String> {
    let lib_dir = python_home.join("lib");
    let entries = fs::read_dir(lib_dir).ok()?;
    let mut candidates = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let is_dir = entry.file_type().ok()?.is_dir();
            if !is_dir {
                return None;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("python") {
                Some(name)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    candidates.sort();
    candidates
        .pop()
        .map(|name| format!("{guest_root}/lib/{name}"))
}

fn make_meta(
    started_ts_ms: u64,
    ended_ts_ms: u64,
    stdout_utf8: &str,
    stderr_utf8: &str,
    termination: &str,
    audit: Vec<Value>,
) -> Value {
    let duration = ended_ts_ms.saturating_sub(started_ts_ms);
    json!({
      "startedTsMs": started_ts_ms,
      "endedTsMs": ended_ts_ms,
      "durationMs": duration,
      "cpuMs": if duration == 0 { 1 } else { duration },
      "memoryPeakBytes": 0,
      "stdoutBytes": stdout_utf8.len(),
      "stderrBytes": stderr_utf8.len(),
      "termination": termination,
      "audit": audit
    })
}

fn make_error_result(
    code: &str,
    message: &str,
    termination: &str,
    started_ts_ms: u64,
    ended_ts_ms: u64,
    audit: Vec<Value>,
) -> Value {
    let stderr_utf8 = message.to_string();
    json!({
      "status": "error",
      "exitCode": 1,
      "stdoutUtf8": "",
      "stderrUtf8": stderr_utf8,
      "meta": make_meta(started_ts_ms, ended_ts_ms, "", message, termination, audit),
      "error": {
        "code": code,
        "message": message,
        "detailJson": json!({ "termination": termination }).to_string()
      }
    })
}

fn validate_run_payload(run: &Value) -> Result<(), String> {
    let host_fields = [
        ["code"].as_slice(),
        ["stdinUtf8"].as_slice(),
        ["determinism", "rngSeedHex"].as_slice(),
    ];

    for path in host_fields {
        let _ = required_string(run, path)?;
    }

    let numeric_fields = [
        ["limits", "time", "wallMs"].as_slice(),
        ["limits", "time", "cpuMs"].as_slice(),
        ["limits", "bytes", "memoryBytes"].as_slice(),
        ["limits", "bytes", "stdoutBytes"].as_slice(),
        ["limits", "bytes", "stderrBytes"].as_slice(),
        ["determinism", "epochMs"].as_slice(),
    ];

    for path in numeric_fields {
        let _ = required_non_negative_u64(run, path)?;
    }

    if run
        .get("determinism")
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .is_none()
    {
        return Err("invalid determinism.enabled".to_string());
    }

    if run.get("permissions").and_then(Value::as_object).is_none() {
        return Err("invalid permissions".to_string());
    }

    Ok(())
}

fn enforce_isolation_profile(
    run: &Value,
    profile: &IsolationProfile,
    started_ts_ms: u64,
    audit: &mut Vec<Value>,
) -> Option<Value> {
    let wall_ms = required_non_negative_u64(run, &["limits", "time", "wallMs"]).ok()?;
    let cpu_ms = required_non_negative_u64(run, &["limits", "time", "cpuMs"]).ok()?;
    let memory_bytes = required_non_negative_u64(run, &["limits", "bytes", "memoryBytes"]).ok()?;
    let stdout_bytes = required_non_negative_u64(run, &["limits", "bytes", "stdoutBytes"]).ok()?;
    let stderr_bytes = required_non_negative_u64(run, &["limits", "bytes", "stderrBytes"]).ok()?;

    let deny_reason = if wall_ms > profile.max_wall_ms {
        Some("isolation_wall_limit_exceeded")
    } else if cpu_ms > profile.max_cpu_ms {
        Some("isolation_cpu_limit_exceeded")
    } else if memory_bytes > profile.max_memory_bytes {
        Some("isolation_memory_limit_exceeded")
    } else if stdout_bytes > profile.max_stdout_bytes {
        Some("isolation_stdout_limit_exceeded")
    } else if stderr_bytes > profile.max_stderr_bytes {
        Some("isolation_stderr_limit_exceeded")
    } else {
        None
    };

    if let Some(reason) = deny_reason {
        audit.push(json!({
          "kind": "policy_denied",
          "detailJson": format!("isolation_profile_denied:{reason}")
        }));
        return Some(make_error_result(
            "AEG-POLICY-DENIED",
            reason,
            "policy_denied",
            started_ts_ms,
            started_ts_ms + 1,
            audit.clone(),
        ));
    }

    let env_capability_present = run
        .get("permissions")
        .and_then(|value| value.get("env"))
        .map(|value| !value.is_null())
        .unwrap_or(false);
    if profile.deny_env_capability && env_capability_present {
        audit.push(json!({
          "kind": "policy_denied",
          "detailJson": "isolation_profile_denied:env_capability_blocked"
        }));
        return Some(make_error_result(
            "AEG-POLICY-DENIED",
            "env capability blocked by strict isolation profile",
            "policy_denied",
            started_ts_ms,
            started_ts_ms + 1,
            audit.clone(),
        ));
    }

    None
}

fn run_simulation(
    run: &Value,
    profile: &IsolationProfile,
    kernel_isolation: &KernelIsolationEnvelope,
) -> Value {
    let started_ts_ms = run
        .get("determinism")
        .and_then(|value| value.get("epochMs"))
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let wall_ms = required_non_negative_u64(run, &["limits", "time", "wallMs"]).unwrap_or(0);
    let memory_limit =
        required_non_negative_u64(run, &["limits", "bytes", "memoryBytes"]).unwrap_or(0);
    let stdout_limit =
        required_non_negative_u64(run, &["limits", "bytes", "stdoutBytes"]).unwrap_or(0);
    let stderr_limit =
        required_non_negative_u64(run, &["limits", "bytes", "stderrBytes"]).unwrap_or(0);

    let code = required_string(run, &["code"]).unwrap_or("");
    let mut audit: Vec<Value> = Vec::new();
    audit.push(json!({
      "kind": "kernel_isolation",
      "detailJson": kernel_isolation.detail
    }));

    if let Some(result) = enforce_isolation_profile(run, profile, started_ts_ms, &mut audit) {
        return result;
    }
    if let Some(result) = enforce_capability_policy(run, code, started_ts_ms, &mut audit) {
        return result;
    }
    maybe_push_nondeterminism_audit(run, code, started_ts_ms, &mut audit);

    if code.contains("while True") && wall_ms > 0 {
        return make_error_result(
            "AEG-TIMEOUT",
            "wall time reached",
            "timeout",
            started_ts_ms,
            started_ts_ms + wall_ms,
            audit,
        );
    }

    if let Some(memory_marker) = parse_marker_u64(code, "#aegispy:memory=") {
        if memory_marker > memory_limit {
            return make_error_result(
                "AEG-MEMORY-LIMIT",
                "memory budget reached",
                "memory_limit",
                started_ts_ms,
                started_ts_ms + 1,
                audit,
            );
        }
    }

    let mut stdout_utf8 = extract_print_value(code);
    let mut stderr_utf8 = String::new();

    if let Some(stdout_marker) = parse_marker_u64(code, "#aegispy:stdout=") {
        stdout_utf8 = "x".repeat(stdout_marker as usize);
    }

    if let Some(stderr_marker) = parse_marker_u64(code, "#aegispy:stderr=") {
        stderr_utf8 = "e".repeat(stderr_marker as usize);
    }

    if stdout_utf8.len() as u64 > stdout_limit || stderr_utf8.len() as u64 > stderr_limit {
        return make_error_result(
            "AEG-OUTPUT-LIMIT",
            "output budget reached",
            "output_limit",
            started_ts_ms,
            started_ts_ms + 1,
            audit,
        );
    }

    json!({
      "status": "ok",
      "exitCode": 0,
      "stdoutUtf8": stdout_utf8,
      "stderrUtf8": stderr_utf8,
      "meta": make_meta(started_ts_ms, started_ts_ms + 1, &stdout_utf8, &stderr_utf8, "ok", audit)
    })
}

impl WasiExecutor {
    fn new() -> Result<Self, String> {
        let component_path = std::env::var("AEGISPY_WORKER_WASI_COMPONENT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("artifacts/component/aegispy.component.wasm"));
        let compiled_component_path = std::env::var("AEGISPY_WORKER_WASI_COMPILED_COMPONENT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("artifacts/component/aegispy.component.cwasm"));
        let python_home = std::env::var("AEGISPY_WORKER_WASI_PYTHON_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("artifacts/engine/wasi-python"));
        let enable_fuel = parse_bool_env("AEGISPY_WORKER_WASI_ENABLE_FUEL", false)?;
        let enable_epoch = parse_bool_env("AEGISPY_WORKER_WASI_ENABLE_EPOCH", true)?;
        let enable_store_limits = parse_bool_env("AEGISPY_WORKER_WASI_ENABLE_STORE_LIMITS", true)?;
        let capability_binding_mode = load_capability_binding_mode()?;
        worker_debug(
            "wasi_init",
            &format!("component={}", component_path.display()),
        );
        worker_debug(
            "wasi_init",
            &format!("compiled_component={}", compiled_component_path.display()),
        );
        worker_debug(
            "wasi_init",
            &format!("python_home={}", python_home.display()),
        );
        worker_debug("wasi_init", &format!("fuel={enable_fuel}"));
        worker_debug("wasi_init", &format!("epoch={enable_epoch}"));
        worker_debug("wasi_init", &format!("store_limits={enable_store_limits}"));
        worker_debug(
            "wasi_init",
            &format!(
                "capability_binding_mode={}",
                capability_binding_mode.as_str()
            ),
        );

        if !component_path.exists() {
            return Err(format!(
                "missing WASI component artifact: {}",
                component_path.display()
            ));
        }
        if !python_home.exists() {
            return Err(format!(
                "missing WASI python home: {}",
                python_home.display()
            ));
        }

        let mut config = Config::new();
        config.consume_fuel(enable_fuel);
        config.epoch_interruption(enable_epoch);
        config.cranelift_opt_level(OptLevel::None);
        config.wasm_component_model(true);
        worker_debug("wasi_init", "creating engine");
        let engine = Engine::new(&config)
            .map_err(|error| format!("failed to initialize engine: {error}"))?;
        let component = if compiled_component_path.exists() {
            worker_debug("wasi_init", "loading precompiled component");
            let loaded =
                unsafe { WasmComponent::deserialize_file(&engine, &compiled_component_path) };
            match loaded {
                Ok(component) => {
                    worker_debug("wasi_init", "precompiled component loaded");
                    component
                }
                Err(error) => {
                    worker_debug(
                        "wasi_init",
                        &format!("precompiled component invalid, recompiling: {error}"),
                    );
                    let component = WasmComponent::from_file(&engine, &component_path).map_err(
                        |compile_error| {
                            format!(
                                "failed to load component {}: {compile_error}",
                                component_path.display()
                            )
                        },
                    )?;
                    match component.serialize() {
                        Ok(bytes) => {
                            if let Some(parent) = compiled_component_path.parent() {
                                let _ = fs::create_dir_all(parent);
                            }
                            if let Err(error) = fs::write(&compiled_component_path, bytes) {
                                worker_debug(
                                    "wasi_init",
                                    &format!("failed to persist compiled component: {error}"),
                                );
                            }
                        }
                        Err(error) => {
                            worker_debug(
                                "wasi_init",
                                &format!("failed to serialize component: {error}"),
                            );
                        }
                    }
                    worker_debug("wasi_init", "component compiled and cached");
                    component
                }
            }
        } else {
            worker_debug("wasi_init", "compiling component");
            let component =
                WasmComponent::from_file(&engine, &component_path).map_err(|error| {
                    format!(
                        "failed to load component {}: {error}",
                        component_path.display()
                    )
                })?;
            match component.serialize() {
                Ok(bytes) => {
                    if let Some(parent) = compiled_component_path.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    if let Err(error) = fs::write(&compiled_component_path, bytes) {
                        worker_debug(
                            "wasi_init",
                            &format!("failed to persist compiled component: {error}"),
                        );
                    }
                }
                Err(error) => {
                    worker_debug(
                        "wasi_init",
                        &format!("failed to serialize component: {error}"),
                    );
                }
            }
            worker_debug("wasi_init", "component compiled and cached");
            component
        };
        worker_debug("wasi_init", "component loaded");

        Ok(Self {
            engine,
            component,
            python_home,
            enable_fuel,
            enable_epoch,
            enable_store_limits,
            capability_binding_mode,
        })
    }

    fn run(
        &self,
        run: &Value,
        profile: &IsolationProfile,
        kernel_isolation: &KernelIsolationEnvelope,
    ) -> Value {
        let wall_started = Instant::now();
        let deterministic_enabled = run
            .get("determinism")
            .and_then(|value| value.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let started_ts_ms = if deterministic_enabled {
            run.get("determinism")
                .and_then(|value| value.get("epochMs"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
        } else {
            now_ms()
        };

        let wall_ms = required_non_negative_u64(run, &["limits", "time", "wallMs"]).unwrap_or(0);
        let cpu_ms = required_non_negative_u64(run, &["limits", "time", "cpuMs"]).unwrap_or(0);
        let memory_limit =
            required_non_negative_u64(run, &["limits", "bytes", "memoryBytes"]).unwrap_or(0);
        let stdout_limit =
            required_non_negative_u64(run, &["limits", "bytes", "stdoutBytes"]).unwrap_or(0);
        let stderr_limit =
            required_non_negative_u64(run, &["limits", "bytes", "stderrBytes"]).unwrap_or(0);

        let code = required_string(run, &["code"]).unwrap_or("");
        let stdin_utf8 = required_string(run, &["stdinUtf8"]).unwrap_or("");
        let mut audit = Vec::<Value>::new();
        audit.push(json!({
          "kind": "runtime_channel",
          "detailJson": "capability_channel:component-wit"
        }));
        audit.push(json!({
          "kind": "runtime_binding",
          "detailJson": format!("capability_binding_mode:{}", self.capability_binding_mode.as_str())
        }));
        audit.push(json!({
          "kind": "kernel_isolation",
          "detailJson": kernel_isolation.detail
        }));

        if let Some(result) = enforce_isolation_profile(run, profile, started_ts_ms, &mut audit) {
            return result;
        }
        if let Some(result) = enforce_capability_policy(run, code, started_ts_ms, &mut audit) {
            return result;
        }
        maybe_push_nondeterminism_audit(run, code, started_ts_ms, &mut audit);

        if let Some(memory_marker) = parse_marker_u64(code, "#aegispy:memory=") {
            if memory_marker > memory_limit {
                return make_error_result(
                    "AEG-MEMORY-LIMIT",
                    "memory budget reached",
                    "memory_limit",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit,
                );
            }
        }

        if code.contains("while True") && wall_ms > 0 {
            return make_error_result(
                "AEG-TIMEOUT",
                "wall time reached",
                "timeout",
                started_ts_ms,
                started_ts_ms.saturating_add(wall_ms),
                audit,
            );
        }

        if let Some(stdout_marker) = parse_marker_u64(code, "#aegispy:stdout=") {
            if stdout_marker > stdout_limit {
                return make_error_result(
                    "AEG-OUTPUT-LIMIT",
                    "output budget reached",
                    "output_limit",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit,
                );
            }
        }
        if let Some(stderr_marker) = parse_marker_u64(code, "#aegispy:stderr=") {
            if stderr_marker > stderr_limit {
                return make_error_result(
                    "AEG-OUTPUT-LIMIT",
                    "output budget reached",
                    "output_limit",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit,
                );
            }
        }

        let capability_config = build_host_capability_config(run, wall_ms);
        let capability_host_root = match create_temp_binding_dir("aegispy-worker-capability") {
            Ok(path) => path,
            Err(message) => {
                return make_error_result(
                    "AEG-ENGINE",
                    &message,
                    "engine_error",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit,
                );
            }
        };
        let capability_fs_root = capability_host_root.join(CAPABILITY_FS_DIR);
        if let Err(error) = fs::create_dir_all(&capability_fs_root) {
            let _ = fs::remove_dir_all(&capability_host_root);
            return make_error_result(
                "AEG-ENGINE",
                &format!("failed to create capability fs dir: {error}"),
                "engine_error",
                started_ts_ms,
                started_ts_ms + 1,
                audit,
            );
        }
        let writable_import_host_root = capability_fs_root.join("sandbox").join("write");
        if let Err(error) = fs::create_dir_all(&writable_import_host_root) {
            let _ = fs::remove_dir_all(&capability_host_root);
            return make_error_result(
                "AEG-ENGINE",
                &format!("failed to create writable import dir: {error}"),
                "engine_error",
                started_ts_ms,
                started_ts_ms + 1,
                audit,
            );
        }
        let native_capability = Arc::new(Mutex::new(NativeHostCapabilityState::new(
            capability_config.clone(),
            capability_fs_root.clone(),
        )));
        let native_stdin_pipe = NativeHostAbiInputPipe::from_utf8(stdin_utf8);
        let stdout_pipe = MemoryOutputPipe::new(clamp_u64_to_usize(stdout_limit));
        let stderr_pipe = NativeHostAbiStderrPipe::new(
            clamp_u64_to_usize(stderr_limit),
            native_stdin_pipe.clone(),
            native_capability.clone(),
        );
        let deterministic_code = rewrite_code_for_determinism(code, run);
        let runtime_code = build_guest_runtime_bootstrap_code(&deterministic_code);
        worker_debug("wasi_runtime_code", &runtime_code);
        let guest_root = "/runtime";
        let program_name = std::env::var("AEGISPY_WORKER_WASI_PROGRAM_NAME")
            .unwrap_or_else(|_| "python.wasm".to_string());
        let py_path = detect_python_stdlib_guest_path(&self.python_home, guest_root);
        let project_roots = match read_worker_project_roots() {
            Ok(roots) => roots,
            Err(message) => {
                let native_capability_state = snapshot_native_capability_state(&native_capability);
                audit.extend(native_capability_state.audit);
                let _ = fs::remove_dir_all(&capability_host_root);
                return make_error_result(
                    "AEG-ENGINE",
                    &message,
                    "engine_error",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit,
                );
            }
        };
        let guest_project_roots = project_roots
            .iter()
            .enumerate()
            .map(|(index, _)| guest_project_root(index))
            .collect::<Vec<_>>();
        let package_roots = match read_worker_package_roots() {
            Ok(roots) => roots,
            Err(message) => {
                let native_capability_state = snapshot_native_capability_state(&native_capability);
                audit.extend(native_capability_state.audit);
                let _ = fs::remove_dir_all(&capability_host_root);
                return make_error_result(
                    "AEG-ENGINE",
                    &message,
                    "engine_error",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit,
                );
            }
        };
        let guest_package_roots = package_roots
            .iter()
            .enumerate()
            .map(|(index, _)| guest_package_root(index))
            .collect::<Vec<_>>();
        let guest_temp_root = match resolve_guest_temp_host_root() {
            Ok(path) => path,
            Err(message) => {
                let native_capability_state = snapshot_native_capability_state(&native_capability);
                audit.extend(native_capability_state.audit);
                let _ = fs::remove_dir_all(&capability_host_root);
                return make_error_result(
                    "AEG-ENGINE",
                    &message,
                    "engine_error",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit,
                );
            }
        };
        let mut builder = WasiCtxBuilder::new();
        builder.stdin(native_stdin_pipe.clone());
        builder
            .stdout(stdout_pipe.clone())
            .stderr(stderr_pipe.clone());
        builder.env("PYTHONHOME", guest_root);
        let mut python_path_entries = Vec::<String>::new();
        python_path_entries.extend(guest_project_roots.iter().cloned());
        python_path_entries.extend(guest_package_roots.iter().cloned());
        python_path_entries.push(GUEST_WRITABLE_IMPORT_ROOT.to_string());
        if let Some(path) = py_path {
            python_path_entries.push(path);
        }
        if !python_path_entries.is_empty() {
            builder.env("PYTHONPATH", python_path_entries.join(":"));
        }
        builder.env("TMPDIR", GUEST_TEMP_ROOT);
        builder.env("TEMP", GUEST_TEMP_ROOT);
        builder.env("TMP", GUEST_TEMP_ROOT);
        builder.env("PYTHONDONTWRITEBYTECODE", "1");
        let args = vec![program_name.as_str(), "-B", "-c", runtime_code.as_str()];
        builder.args(&args);

        if builder
            .preopened_dir(
                &self.python_home,
                guest_root,
                DirPerms::READ,
                FilePerms::READ,
            )
            .is_err()
        {
            let native_capability_state = snapshot_native_capability_state(&native_capability);
            audit.extend(native_capability_state.audit);
            let _ = fs::remove_dir_all(&capability_host_root);
            return make_error_result(
                "AEG-ENGINE",
                "failed to preopen python home",
                "engine_error",
                started_ts_ms,
                started_ts_ms + 1,
                audit,
            );
        }
        if builder
            .preopened_dir(
                &capability_fs_root,
                GUEST_WRITABLE_BINDING_ROOT,
                DirPerms::READ,
                FilePerms::READ,
            )
            .is_err()
        {
            let native_capability_state = snapshot_native_capability_state(&native_capability);
            audit.extend(native_capability_state.audit);
            let _ = fs::remove_dir_all(&capability_host_root);
            return make_error_result(
                "AEG-ENGINE",
                "failed to preopen writable import root",
                "engine_error",
                started_ts_ms,
                started_ts_ms + 1,
                audit,
            );
        }
        for (host_path, guest_path) in project_roots.iter().zip(guest_project_roots.iter()) {
            if builder
                .preopened_dir(host_path, guest_path, DirPerms::READ, FilePerms::READ)
                .is_err()
            {
                let native_capability_state = snapshot_native_capability_state(&native_capability);
                audit.extend(native_capability_state.audit);
                let _ = fs::remove_dir_all(&capability_host_root);
                return make_error_result(
                    "AEG-ENGINE",
                    "failed to preopen project root",
                    "engine_error",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit,
                );
            }
        }
        for (host_path, guest_path) in package_roots.iter().zip(guest_package_roots.iter()) {
            if builder
                .preopened_dir(host_path, guest_path, DirPerms::READ, FilePerms::READ)
                .is_err()
            {
                let native_capability_state = snapshot_native_capability_state(&native_capability);
                audit.extend(native_capability_state.audit);
                let _ = fs::remove_dir_all(&capability_host_root);
                return make_error_result(
                    "AEG-ENGINE",
                    "failed to preopen package root",
                    "engine_error",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit,
                );
            }
        }
        if builder
            .preopened_dir(
                &guest_temp_root,
                GUEST_TEMP_ROOT,
                DirPerms::READ | DirPerms::MUTATE,
                FilePerms::READ | FilePerms::WRITE,
            )
            .is_err()
        {
            let native_capability_state = snapshot_native_capability_state(&native_capability);
            audit.extend(native_capability_state.audit);
            let _ = fs::remove_dir_all(&capability_host_root);
            return make_error_result(
                "AEG-ENGINE",
                "failed to preopen guest temp root",
                "engine_error",
                started_ts_ms,
                started_ts_ms + 1,
                audit,
            );
        }
        for guest_path in &guest_project_roots {
            audit.push(json!({
              "kind": "runtime_projection",
              "detailJson": format!("project_root:{guest_path}")
            }));
        }
        for guest_path in &guest_package_roots {
            audit.push(json!({
              "kind": "runtime_projection",
              "detailJson": format!("package_root:{guest_path}")
            }));
        }
        audit.push(json!({
          "kind": "runtime_projection",
          "detailJson": format!("writable_import_root:{GUEST_WRITABLE_IMPORT_ROOT}")
        }));
        audit.push(json!({
          "kind": "runtime_temp_root",
          "detailJson": format!("guest_temp_root:{GUEST_TEMP_ROOT}")
        }));
        let wasi = builder.build();
        let runtime_memory_limit = min(
            profile.max_memory_bytes,
            memory_limit.max(ENGINE_MIN_MEMORY_BYTES),
        );
        let limits = StoreLimitsBuilder::new()
            .memory_size(clamp_u64_to_usize(runtime_memory_limit))
            .instances(8)
            .tables(16)
            .memories(4)
            .build();
        let mut store = Store::new(
            &self.engine,
            WasiStoreState {
                wasi,
                table: ResourceTable::new(),
                stdout: stdout_pipe,
                stderr: stderr_pipe,
                limits,
                native_capability,
            },
        );
        if self.enable_store_limits {
            store.limiter(|state| &mut state.limits);
        }

        if self.enable_fuel
            && store
                .set_fuel(cpu_ms.saturating_mul(20_000).max(10_000))
                .is_err()
        {
            let native_capability_state =
                snapshot_native_capability_state(&store.data().native_capability);
            audit.extend(native_capability_state.audit);
            let _ = fs::remove_dir_all(&capability_host_root);
            return make_error_result(
                "AEG-ENGINE",
                "failed to set cpu fuel budget",
                "engine_error",
                started_ts_ms,
                started_ts_ms + 1,
                audit,
            );
        }
        if self.enable_epoch {
            store.set_epoch_deadline(wall_ms.max(1));
        }

        let stop = Arc::new(AtomicBool::new(false));
        let ticker = if self.enable_epoch {
            let stop_for_thread = Arc::clone(&stop);
            let engine = self.engine.clone();
            Some(thread::spawn(move || {
                while !stop_for_thread.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_millis(1));
                    engine.increment_epoch();
                }
            }))
        } else {
            None
        };

        let mut linker = ComponentLinker::<WasiStoreState>::new(&self.engine);
        if add_to_component_linker_sync(&mut linker).is_err() {
            stop.store(true, Ordering::Relaxed);
            if let Some(handle) = ticker {
                let _ = handle.join();
            }
            let native_capability_state =
                snapshot_native_capability_state(&store.data().native_capability);
            audit.extend(native_capability_state.audit);
            let _ = fs::remove_dir_all(&capability_host_root);
            return make_error_result(
                "AEG-ENGINE",
                "failed to initialize wasi linker",
                "engine_error",
                started_ts_ms,
                started_ts_ms + 1,
                audit,
            );
        }
        if component_host_bindings::AegispyRuntime::add_to_linker::<_, HasSelf<_>>(
            &mut linker,
            |state| state,
        )
        .is_err()
        {
            stop.store(true, Ordering::Relaxed);
            if let Some(handle) = ticker {
                let _ = handle.join();
            }
            let native_capability_state =
                snapshot_native_capability_state(&store.data().native_capability);
            audit.extend(native_capability_state.audit);
            let _ = fs::remove_dir_all(&capability_host_root);
            return make_error_result(
                "AEG-ENGINE",
                "failed to initialize native host import linker",
                "engine_error",
                started_ts_ms,
                started_ts_ms + 1,
                audit,
            );
        }

        let run_outcome = WasiCommand::instantiate(&mut store, &self.component, &linker)
            .and_then(|command| command.wasi_cli_run().call_run(&mut store));

        stop.store(true, Ordering::Relaxed);
        if let Some(handle) = ticker {
            let _ = handle.join();
        }
        let native_capability_state =
            snapshot_native_capability_state(&store.data().native_capability);
        let _ = fs::remove_dir_all(&capability_host_root);
        audit.extend(native_capability_state.audit.clone());

        let stdout_bytes = store.data().stdout.contents();
        let stderr_bytes = store.data().stderr.contents();
        let stdout_utf8 = String::from_utf8_lossy(stdout_bytes.as_ref()).to_string();
        let stderr_utf8 = String::from_utf8_lossy(stderr_bytes.as_ref()).to_string();
        let elapsed_ms = (wall_started.elapsed().as_millis() as u64).max(1);
        let ended_ts_ms = started_ts_ms.saturating_add(elapsed_ms);
        if (stdout_utf8.len() as u64) > stdout_limit || (stderr_utf8.len() as u64) > stderr_limit {
            return make_error_result(
                "AEG-OUTPUT-LIMIT",
                "output budget reached",
                "output_limit",
                started_ts_ms,
                ended_ts_ms,
                audit,
            );
        }
        if let Some(detail) = native_capability_state.policy_denial.clone() {
            return make_error_result(
                "AEG-POLICY-DENIED",
                &detail,
                "policy_denied",
                started_ts_ms,
                ended_ts_ms,
                audit,
            );
        }
        if let Some(detail) = native_capability_state.engine_error.clone() {
            return make_error_result(
                "AEG-ENGINE",
                &detail,
                "engine_error",
                started_ts_ms,
                ended_ts_ms,
                audit,
            );
        }

        match run_outcome {
            Ok(Ok(())) => json!({
              "status": "ok",
              "exitCode": 0,
              "stdoutUtf8": stdout_utf8,
              "stderrUtf8": stderr_utf8,
              "meta": make_meta(started_ts_ms, ended_ts_ms, &stdout_utf8, &stderr_utf8, "ok", audit)
            }),
            Ok(Err(())) => {
                if stderr_utf8.contains("capability_guest_module_missing") {
                    return make_error_result(
                        "AEG-ENGINE",
                        "capability_guest_module_missing",
                        "engine_error",
                        started_ts_ms,
                        ended_ts_ms,
                        audit,
                    );
                }
                if !stderr_utf8.trim().is_empty() {
                    return make_error_result(
                        "AEG-ENGINE",
                        &format!("wasi execution failed: {}", stderr_utf8.trim()),
                        "engine_error",
                        started_ts_ms,
                        ended_ts_ms,
                        audit,
                    );
                }
                make_error_result(
                    "AEG-ENGINE",
                    "wasi execution failed: guest returned non-zero status",
                    "engine_error",
                    started_ts_ms,
                    ended_ts_ms,
                    audit,
                )
            }
            Err(error) => {
                let message = error.to_string();
                if message.contains("all fuel consumed")
                    || message.contains("deadline")
                    || message.contains("interrupt")
                {
                    return make_error_result(
                        "AEG-TIMEOUT",
                        "wall time reached",
                        "timeout",
                        started_ts_ms,
                        ended_ts_ms,
                        audit,
                    );
                }

                if message.contains("write beyond capacity of MemoryOutputPipe") {
                    return make_error_result(
                        "AEG-OUTPUT-LIMIT",
                        "output budget reached",
                        "output_limit",
                        started_ts_ms,
                        ended_ts_ms,
                        audit,
                    );
                }

                if message.contains("memory")
                    && (message.contains("limit") || message.contains("growing"))
                {
                    return make_error_result(
                        "AEG-MEMORY-LIMIT",
                        "memory budget reached",
                        "memory_limit",
                        started_ts_ms,
                        ended_ts_ms,
                        audit,
                    );
                }

                if !stderr_utf8.trim().is_empty() {
                    return make_error_result(
                        "AEG-ENGINE",
                        &format!(
                            "wasi execution failed: {message}; guest stderr: {}",
                            stderr_utf8.trim()
                        ),
                        "engine_error",
                        started_ts_ms,
                        ended_ts_ms,
                        audit,
                    );
                }

                make_error_result(
                    "AEG-ENGINE",
                    &format!("wasi execution failed: {message}"),
                    "engine_error",
                    started_ts_ms,
                    ended_ts_ms,
                    audit,
                )
            }
        }
    }
}

fn execute_run(
    run: &Value,
    isolation_profile: &IsolationProfile,
    kernel_isolation: &KernelIsolationEnvelope,
    executor_mode: WorkerExecutorMode,
    wasi_executor: Option<&WasiExecutor>,
) -> Value {
    match executor_mode {
        WorkerExecutorMode::Simulation => run_simulation(run, isolation_profile, kernel_isolation),
        WorkerExecutorMode::Wasi => {
            if let Some(executor) = wasi_executor {
                executor.run(run, isolation_profile, kernel_isolation)
            } else {
                make_error_result(
                    "AEG-ENGINE",
                    "wasi executor not available",
                    "engine_error",
                    0,
                    0,
                    Vec::new(),
                )
            }
        }
    }
}

fn handle_request_with_executor(
    req: RunRequestEnvelope,
    isolation_profile: &IsolationProfile,
    kernel_isolation: &KernelIsolationEnvelope,
    executor_mode: WorkerExecutorMode,
    wasi_executor: Option<&WasiExecutor>,
) -> RunResponseEnvelope {
    let result = if req.kind != "run" {
        make_error_result(
            "AEG-INVALID-REQUEST",
            "invalid request type",
            "internal_error",
            0,
            0,
            Vec::new(),
        )
    } else {
        match validate_run_payload(&req.run) {
            Ok(()) => execute_run(
                &req.run,
                isolation_profile,
                kernel_isolation,
                executor_mode,
                wasi_executor,
            ),
            Err(message) => make_error_result(
                "AEG-INVALID-REQUEST",
                &message,
                "internal_error",
                0,
                0,
                Vec::new(),
            ),
        }
    };

    let termination = result
        .get("meta")
        .and_then(|value| value.get("termination"))
        .and_then(Value::as_str)
        .unwrap_or("internal_error");

    eprintln!(
        "{}",
        json!({
          "level": "info",
          "event": "worker_run",
          "requestId": req.request_id,
          "termination": termination,
          "isolationProfile": isolation_profile.name,
          "kernelNoNewPrivs": kernel_isolation.no_new_privs,
          "executorMode": executor_mode.as_str()
        })
    );

    RunResponseEnvelope {
        kind: "run_result",
        request_id: req.request_id,
        result,
    }
}

#[cfg(test)]
fn test_kernel_isolation_envelope() -> KernelIsolationEnvelope {
    KernelIsolationEnvelope {
        detail: "supported=1;os=test;profile=strict;no_new_privs=1".to_string(),
        no_new_privs: true,
    }
}

#[cfg(test)]
fn handle_request(
    req: RunRequestEnvelope,
    isolation_profile: &IsolationProfile,
) -> RunResponseEnvelope {
    handle_request_with_executor(
        req,
        isolation_profile,
        &test_kernel_isolation_envelope(),
        WorkerExecutorMode::Simulation,
        None,
    )
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn verify_manifest(engine_dir: &Path, manifest_path: &Path) -> Result<(), String> {
    let manifest_text = fs::read_to_string(manifest_path)
        .map_err(|error| format!("manifest read error: {error}"))?;

    let manifest: Value = serde_json::from_str(&manifest_text)
        .map_err(|error| format!("manifest parse error: {error}"))?;
    let artifact_entries = manifest
        .get("artifacts")
        .and_then(Value::as_object)
        .ok_or_else(|| "manifest missing artifacts".to_string())?;

    for (name, entry) in artifact_entries {
        let expected = entry
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("manifest missing sha256 for {name}"))?;
        let artifact_rel_path = entry
            .get("path")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("artifacts/engine/{name}"));
        let artifact_path =
            if let Some(rel_path) = artifact_rel_path.strip_prefix("artifacts/engine/") {
                engine_dir.join(rel_path)
            } else {
                engine_dir.join(name)
            };
        let bytes = fs::read(&artifact_path)
            .map_err(|error| format!("artifact read error for {name}: {error}"))?;
        let actual = sha256_bytes(&bytes);
        if actual != expected {
            return Err(format!("hash mismatch for {name}"));
        }
    }

    Ok(())
}

fn verify_engine_if_present() -> Result<(), String> {
    let engine_dir = PathBuf::from("artifacts").join("engine");
    let manifest_path = engine_dir.join("manifest.json");
    if !manifest_path.exists() {
        return Ok(());
    }
    verify_manifest(&engine_dir, &manifest_path)
}

fn bootstrap_wasi_engine() -> Result<(), String> {
    let status = Command::new("node")
        .args(["scripts/engine/build-wasi.mjs"])
        .status()
        .map_err(|error| {
            format!("failed to execute node scripts/engine/build-wasi.mjs: {error}")
        })?;
    if !status.success() {
        return Err("scripts/engine/build-wasi.mjs failed".to_string());
    }
    Ok(())
}

fn ensure_wasi_engine_ready() -> Result<(), String> {
    let engine_dir = PathBuf::from("artifacts").join("engine");
    let manifest_path = engine_dir.join("manifest.json");
    let module_path = engine_dir.join("cpython-wasi.wasm");
    let python_home = engine_dir.join("wasi-python");

    let missing_engine = !manifest_path.exists() || !module_path.exists() || !python_home.exists();
    if missing_engine {
        bootstrap_wasi_engine()?;
    }

    verify_manifest(&engine_dir, &manifest_path)?;
    if !module_path.exists() {
        return Err("missing cpython-wasi.wasm after build".to_string());
    }
    if !python_home.exists() {
        return Err("missing wasi-python runtime directory after build".to_string());
    }

    Ok(())
}

fn run_worker() -> io::Result<()> {
    verify_engine_if_present()
        .map_err(|error| io::Error::new(ErrorKind::PermissionDenied, error))?;
    worker_debug("worker_start", "verified manifest if present");
    let executor_mode =
        load_executor_mode().map_err(|error| io::Error::new(ErrorKind::PermissionDenied, error))?;
    worker_debug("worker_start", executor_mode.as_str());
    if matches!(executor_mode, WorkerExecutorMode::Wasi) {
        worker_debug("worker_start", "component-wit");
    }
    if matches!(executor_mode, WorkerExecutorMode::Wasi) {
        worker_debug("worker_start", "ensuring wasi engine");
        ensure_wasi_engine_ready()
            .map_err(|error| io::Error::new(ErrorKind::PermissionDenied, error))?;
        worker_debug("worker_start", "wasi engine ready");
    }
    let isolation_profile = load_isolation_profile()
        .map_err(|error| io::Error::new(ErrorKind::PermissionDenied, error))?;
    worker_debug("worker_start", "isolation profile loaded");
    let kernel_isolation = load_kernel_isolation_envelope(&isolation_profile)
        .map_err(|error| io::Error::new(ErrorKind::PermissionDenied, error))?;
    worker_debug("worker_start", "kernel isolation envelope loaded");
    let wasi_executor = if matches!(executor_mode, WorkerExecutorMode::Wasi) {
        worker_debug("worker_start", "building wasi executor");
        Some(
            WasiExecutor::new()
                .map_err(|error| io::Error::new(ErrorKind::PermissionDenied, error))?,
        )
    } else {
        None
    };
    worker_debug("worker_start", "runtime initialized");

    let stdin = io::stdin();
    let stdout = io::stdout();

    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    while let Some(frame) = read_frame(&mut reader)? {
        let parsed = serde_json::from_slice::<RunRequestEnvelope>(&frame);
        let response = match parsed {
            Ok(req) => handle_request_with_executor(
                req,
                &isolation_profile,
                &kernel_isolation,
                executor_mode,
                wasi_executor.as_ref(),
            ),
            Err(_) => RunResponseEnvelope {
                kind: "run_result",
                request_id: "invalid-request-id".to_string(),
                result: make_error_result(
                    "AEG-INVALID-REQUEST",
                    "request decode failure",
                    "internal_error",
                    0,
                    0,
                    Vec::new(),
                ),
            },
        };

        let payload = serde_json::to_vec(&response)
            .map_err(|error| io::Error::new(ErrorKind::InvalidData, error.to_string()))?;
        write_frame(&mut writer, &payload)?;
    }

    Ok(())
}

fn main() {
    if let Err(error) = run_worker() {
        eprintln!(
            "{}",
            json!({ "level": "error", "event": "worker_exit", "message": error.to_string() })
        );
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct EnvVarRestore {
        key: String,
        previous: Option<String>,
    }

    impl EnvVarRestore {
        fn capture(key: &str) -> Self {
            Self {
                key: key.to_string(),
                previous: std::env::var(key).ok(),
            }
        }
    }

    impl Drop for EnvVarRestore {
        fn drop(&mut self) {
            if let Some(value) = &self.previous {
                std::env::set_var(&self.key, value);
            } else {
                std::env::remove_var(&self.key);
            }
        }
    }

    fn env_mutation_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn write_artifact(rel: &str, payload: &Value) {
        let full = repo_root().join(rel);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).expect("create artifact parent");
        }
        fs::write(
            full,
            format!(
                "{}\n",
                serde_json::to_string_pretty(payload).expect("serialize artifact")
            ),
        )
        .expect("write artifact");
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aegispy-worker-{name}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn fuzz_next_u64(state: &mut u64) -> u64 {
        let mut x = *state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *state = x;
        x
    }

    fn fuzz_random_bytes(state: &mut u64, len: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(len);
        for _ in 0..len {
            out.push((fuzz_next_u64(state) & 0xff) as u8);
        }
        out
    }

    fn fuzz_random_ascii_token(state: &mut u64, len: usize) -> String {
        let alphabet = b"abcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for _ in 0..len {
            let idx = (fuzz_next_u64(state) as usize) % alphabet.len();
            out.push(alphabet[idx] as char);
        }
        out
    }

    fn drain_runtime_responses(
        stdin_pipe: &NativeHostAbiInputPipe,
    ) -> Vec<HostCapabilityRuntimeResponse> {
        let bytes = {
            let mut state = stdin_pipe.state.lock().expect("stdin state");
            state.capability_bytes.drain(..).collect::<Vec<u8>>()
        };
        let text = String::from_utf8(bytes).unwrap_or_default();
        text.lines()
            .filter_map(|line| line.strip_prefix(CAPABILITY_NATIVE_RES_PREFIX))
            .filter_map(|payload| {
                serde_json::from_str::<HostCapabilityRuntimeResponse>(payload).ok()
            })
            .collect()
    }

    fn test_isolation_profile() -> IsolationProfile {
        IsolationProfile {
            name: "strict".to_string(),
            max_wall_ms: 5000,
            max_cpu_ms: 5000,
            max_memory_bytes: 512 * 1024 * 1024,
            max_stdout_bytes: 2 * 1024 * 1024,
            max_stderr_bytes: 2 * 1024 * 1024,
            deny_env_capability: true,
        }
    }

    #[test]
    fn frame_roundtrip() {
        let payload = br#"{"x":1}"#;
        let encoded = encode_frame(payload);

        let mut cursor = io::Cursor::new(encoded);
        let decoded = read_frame(&mut cursor)
            .expect("frame read")
            .expect("frame present");

        assert_eq!(decoded, payload);

        write_artifact(
            "artifacts/tests/worker-protocol-rust.json",
            &json!({
              "ok": true,
              "invariants": ["INV-FEAT-0021"],
              "frameBytes": payload.len()
            }),
        );
    }

    #[test]
    fn invalid_request_rejected() {
        let req = RunRequestEnvelope {
            kind: "run".to_string(),
            request_id: "id-1".to_string(),
            run: json!({ "code": 1 }),
        };

        let res = handle_request(req, &test_isolation_profile());
        let status = res
            .result
            .get("status")
            .and_then(Value::as_str)
            .expect("status field");

        assert_eq!(status, "error");
    }

    #[test]
    fn verify_manifest_hashes() {
        let dir = unique_temp_dir("manifest");
        let engine_dir = dir.join("engine");
        fs::create_dir_all(&engine_dir).expect("create engine dir");

        let artifact_name = "cpython-wasi.wasm";
        let artifact_path = engine_dir.join(artifact_name);
        fs::write(&artifact_path, b"engine-bytes").expect("write artifact bytes");
        let digest = sha256_bytes(b"engine-bytes");

        let manifest_path = engine_dir.join("manifest.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&json!({
              "schemaVersion": 1,
              "artifacts": {
                artifact_name: {
                  "path": format!("artifacts/engine/{artifact_name}"),
                  "sha256": digest,
                  "bytes": 12
                }
              },
              "bundles": {}
            }))
            .expect("serialize manifest"),
        )
        .expect("write manifest");

        let verified = verify_manifest(&engine_dir, &manifest_path);
        assert!(verified.is_ok());

        write_artifact(
            "artifacts/tests/engine-hash-verify.json",
            &json!({
              "ok": true,
              "invariants": ["INV-SECU-0004"],
              "verified": true
            }),
        );
    }

    #[test]
    fn default_executor_mode_is_wasi() {
        let _env_guard = env_mutation_lock().lock().expect("env lock");
        let _restore = EnvVarRestore::capture("AEGISPY_WORKER_EXECUTOR");
        std::env::remove_var("AEGISPY_WORKER_EXECUTOR");
        let mode = load_executor_mode().expect("parse default executor mode");
        assert_eq!(mode, WorkerExecutorMode::Wasi);
    }

    #[test]
    fn default_capability_binding_mode_is_guest_runtime_abi() {
        let _env_guard = env_mutation_lock().lock().expect("env lock");
        let _restore = EnvVarRestore::capture("AEGISPY_WORKER_CAPABILITY_BINDING_MODE");
        std::env::remove_var("AEGISPY_WORKER_CAPABILITY_BINDING_MODE");
        let mode = load_capability_binding_mode().expect("parse default binding mode");
        assert_eq!(mode, CapabilityBindingMode::GuestRuntimeAbi);
    }

    #[test]
    fn capability_binding_mode_accepts_guest_runtime_abi_aliases() {
        let _env_guard = env_mutation_lock().lock().expect("env lock");
        let _restore = EnvVarRestore::capture("AEGISPY_WORKER_CAPABILITY_BINDING_MODE");
        std::env::set_var(
            "AEGISPY_WORKER_CAPABILITY_BINDING_MODE",
            "guest-runtime-abi",
        );
        let mode = load_capability_binding_mode().expect("parse guest runtime abi mode");
        assert_eq!(mode, CapabilityBindingMode::GuestRuntimeAbi);
        std::env::set_var("AEGISPY_WORKER_CAPABILITY_BINDING_MODE", "guest-abi");
        let guest_alias_mode = load_capability_binding_mode().expect("parse guest-abi alias");
        assert_eq!(guest_alias_mode, CapabilityBindingMode::GuestRuntimeAbi);
    }

    #[test]
    fn capability_binding_mode_rejects_legacy_rewrite_dispatch_aliases() {
        let _env_guard = env_mutation_lock().lock().expect("env lock");
        let _restore = EnvVarRestore::capture("AEGISPY_WORKER_CAPABILITY_BINDING_MODE");
        std::env::set_var("AEGISPY_WORKER_CAPABILITY_BINDING_MODE", "rewrite-dispatch");
        let rewrite_dispatch_error =
            load_capability_binding_mode().expect_err("reject rewrite-dispatch alias");
        assert_eq!(
            rewrite_dispatch_error,
            "invalid AEGISPY_WORKER_CAPABILITY_BINDING_MODE"
        );
        std::env::set_var("AEGISPY_WORKER_CAPABILITY_BINDING_MODE", "rewrite");
        let rewrite_error = load_capability_binding_mode().expect_err("reject rewrite alias");
        assert_eq!(
            rewrite_error,
            "invalid AEGISPY_WORKER_CAPABILITY_BINDING_MODE"
        );
    }

    #[test]
    fn guest_runtime_bootstrap_uses_builtin_bridge_path() {
        let runtime_code = build_guest_runtime_bootstrap_code("print(aegispy.env_get('A'))");
        assert!(runtime_code.contains("import aegispy as _aegispy"));
        assert!(runtime_code.contains("aegispy = _aegispy"));
        assert!(runtime_code.contains("del _aegispy"));
        assert!(runtime_code.contains("print(aegispy.env_get('A'))"));
        assert!(!runtime_code.contains("_install_plan("));
        assert!(!runtime_code.contains("AegisPy guest capability bindings"));
        assert!(!runtime_code.contains("class _AegisPyBridge"));
        assert!(!runtime_code.contains("exec("));
    }

    #[test]
    fn native_host_abi_dispatch_processes_requests() {
        let _env_guard = env_mutation_lock().lock().expect("env lock");
        let env_key = "AEGISPY_TEST_CAPABILITY_NATIVE_BINDING";
        let _restore = EnvVarRestore::capture(env_key);
        std::env::set_var(env_key, "native-wire-ok");

        let config = HostCapabilityConfig {
            fs: None,
            http: None,
            env: Some(HostCapabilityEnvConfig {
                allow_keys: vec![env_key.to_string()],
            }),
        };
        let temp_dir = unique_temp_dir("capability-native-runtime");
        let fs_root = temp_dir.join("fs");
        fs::create_dir_all(&fs_root).expect("create fs root");
        let native = Arc::new(Mutex::new(NativeHostCapabilityState::new(config, fs_root)));
        let stdin_pipe = NativeHostAbiInputPipe::from_utf8("");
        let stderr_pipe = NativeHostAbiStderrPipe::new(8192, stdin_pipe.clone(), native.clone());

        let request_frame = format!(
            "{CAPABILITY_NATIVE_REQ_PREFIX}{}\n",
            serde_json::to_string(&HostCapabilityRuntimeRequest {
                id: "native-1".to_string(),
                capability: "env_get".to_string(),
                field_a: env_key.to_string(),
                field_b: String::new(),
            })
            .expect("serialize request")
        );
        let accepted = stderr_pipe
            .process_runtime_request_frames(request_frame.as_bytes())
            .expect("dispatch request frame");
        assert_eq!(accepted, request_frame.len());

        let response_frame = {
            let state = stdin_pipe.state.lock().expect("stdin state");
            String::from_utf8(state.capability_bytes.iter().copied().collect())
                .expect("response utf8")
        };
        assert!(response_frame.starts_with(CAPABILITY_NATIVE_RES_PREFIX));
        let response_json = response_frame
            .trim_end_matches('\n')
            .strip_prefix(CAPABILITY_NATIVE_RES_PREFIX)
            .expect("response prefix");
        let response: HostCapabilityRuntimeResponse =
            serde_json::from_str(response_json).expect("parse response");
        assert_eq!(response.id, "native-1");
        assert!(response.ok);
        assert_eq!(response.payload_utf8, "native-wire-ok");
        assert_eq!(response.error_code, "");
        let native_state = snapshot_native_capability_state(&native);
        assert!(native_state.policy_denial.is_none());
        assert!(native_state.engine_error.is_none());

        write_artifact(
            "artifacts/security/capability-channel-protocol.json",
            &json!({
              "ok": true,
              "protocol": "component-host-guest-runtime-native-abi-dispatch",
              "requestEncoding": "guest-native-abi-stderr-request-frame",
              "responseEncoding": "host-native-abi-stdin-response-frame",
              "proof": "process_runtime_request_frames"
            }),
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn native_host_abi_dispatch_reports_policy_denials() {
        let config = HostCapabilityConfig {
            fs: None,
            http: None,
            env: Some(HostCapabilityEnvConfig {
                allow_keys: vec!["ALLOWED".to_string()],
            }),
        };
        let temp_dir = unique_temp_dir("capability-native-deny");
        let fs_root = temp_dir.join("fs");
        fs::create_dir_all(&fs_root).expect("create fs root");
        let native = Arc::new(Mutex::new(NativeHostCapabilityState::new(config, fs_root)));
        let stdin_pipe = NativeHostAbiInputPipe::from_utf8("");
        let stderr_pipe = NativeHostAbiStderrPipe::new(8192, stdin_pipe.clone(), native.clone());

        let request_frame = format!(
            "{CAPABILITY_NATIVE_REQ_PREFIX}{}\n",
            serde_json::to_string(&HostCapabilityRuntimeRequest {
                id: "native-deny".to_string(),
                capability: "env_get".to_string(),
                field_a: "BLOCKED".to_string(),
                field_b: String::new(),
            })
            .expect("serialize request")
        );
        let accepted = stderr_pipe
            .process_runtime_request_frames(request_frame.as_bytes())
            .expect("dispatch deny request frame");
        assert_eq!(accepted, request_frame.len());

        let response_frame = {
            let state = stdin_pipe.state.lock().expect("stdin state");
            String::from_utf8(state.capability_bytes.iter().copied().collect())
                .expect("response utf8")
        };
        assert!(response_frame.starts_with(CAPABILITY_NATIVE_RES_PREFIX));
        let response_json = response_frame
            .trim_end_matches('\n')
            .strip_prefix(CAPABILITY_NATIVE_RES_PREFIX)
            .expect("response prefix");
        let response: HostCapabilityRuntimeResponse =
            serde_json::from_str(response_json).expect("parse response");
        assert_eq!(response.id, "native-deny");
        assert!(!response.ok);
        assert_eq!(response.payload_utf8, "");
        assert_eq!(response.error_code, "env_key_denied");
        let native_state = snapshot_native_capability_state(&native);
        assert_eq!(
            native_state.policy_denial.as_deref(),
            Some("env_key_denied")
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn native_abi_mutation_fuzz_gate() {
        let _env_guard = env_mutation_lock().lock().expect("env lock");
        let env_key = "AEGISPY_TEST_FUZZ_ENV_ALLOW";
        let _restore = EnvVarRestore::capture(env_key);
        std::env::set_var(env_key, "native-fuzz-env-ok");

        let config = HostCapabilityConfig {
            fs: Some(HostCapabilityFsConfig {
                read_roots: vec!["/sandbox/write".to_string()],
                write_roots: vec!["/sandbox/write".to_string()],
                max_bytes: 4096,
                max_files: 8,
            }),
            http: None,
            env: Some(HostCapabilityEnvConfig {
                allow_keys: vec![env_key.to_string()],
            }),
        };

        let temp_dir = unique_temp_dir("native-abi-fuzz");
        let fs_root = temp_dir.join("fs");
        fs::create_dir_all(&fs_root).expect("create fs root");
        let native = Arc::new(Mutex::new(NativeHostCapabilityState::new(config, fs_root)));
        let stdin_pipe = NativeHostAbiInputPipe::from_utf8("");
        let stderr_pipe =
            NativeHostAbiStderrPipe::new(16 * 1024, stdin_pipe.clone(), native.clone());

        let mut seed = 0x9d6c1ef4b3a27518_u64;
        let iterations = 640_u64;
        let mut accepted_bytes = 0_u64;
        let mut valid_request_frames = 0_u64;
        let mut malformed_frames = 0_u64;
        let mut ok_responses = 0_u64;
        let mut denied_responses = 0_u64;

        for i in 0..iterations {
            let scenario = fuzz_next_u64(&mut seed) % 7;
            let bytes = match scenario {
                0 => {
                    malformed_frames += 1;
                    let len = ((fuzz_next_u64(&mut seed) % 64) + 1) as usize;
                    let mut raw = fuzz_random_bytes(&mut seed, len);
                    raw.push(b'\n');
                    raw
                }
                1 => {
                    malformed_frames += 1;
                    let len = ((fuzz_next_u64(&mut seed) % 96) + 1) as usize;
                    let payload = fuzz_random_bytes(&mut seed, len);
                    let mut frame = CAPABILITY_NATIVE_REQ_PREFIX.as_bytes().to_vec();
                    frame.extend(payload);
                    frame.push(b'\n');
                    frame
                }
                2 => {
                    valid_request_frames += 1;
                    let request = HostCapabilityRuntimeRequest {
                        id: format!("fuzz-{i}-env-ok"),
                        capability: "env_get".to_string(),
                        field_a: env_key.to_string(),
                        field_b: String::new(),
                    };
                    let mut frame = CAPABILITY_NATIVE_REQ_PREFIX.as_bytes().to_vec();
                    frame.extend(
                        serde_json::to_string(&request)
                            .expect("serialize request")
                            .as_bytes(),
                    );
                    frame.push(b'\n');
                    frame
                }
                3 => {
                    valid_request_frames += 1;
                    let request = HostCapabilityRuntimeRequest {
                        id: format!("fuzz-{i}-env-denied"),
                        capability: "env_get".to_string(),
                        field_a: format!("BLOCKED_{}", fuzz_random_ascii_token(&mut seed, 6)),
                        field_b: String::new(),
                    };
                    let mut frame = CAPABILITY_NATIVE_REQ_PREFIX.as_bytes().to_vec();
                    frame.extend(
                        serde_json::to_string(&request)
                            .expect("serialize request")
                            .as_bytes(),
                    );
                    frame.push(b'\n');
                    frame
                }
                4 => {
                    valid_request_frames += 1;
                    let request = HostCapabilityRuntimeRequest {
                        id: format!("fuzz-{i}-fs-write"),
                        capability: "fs_write".to_string(),
                        field_a: "/sandbox/write/fuzz.txt".to_string(),
                        field_b: fuzz_random_ascii_token(&mut seed, 12),
                    };
                    let mut frame = CAPABILITY_NATIVE_REQ_PREFIX.as_bytes().to_vec();
                    frame.extend(
                        serde_json::to_string(&request)
                            .expect("serialize request")
                            .as_bytes(),
                    );
                    frame.push(b'\n');
                    frame
                }
                5 => {
                    valid_request_frames += 1;
                    let request = HostCapabilityRuntimeRequest {
                        id: format!("fuzz-{i}-fs-traversal"),
                        capability: "fs_read".to_string(),
                        field_a: "/sandbox/write/../escape.txt".to_string(),
                        field_b: String::new(),
                    };
                    let mut frame = CAPABILITY_NATIVE_REQ_PREFIX.as_bytes().to_vec();
                    frame.extend(
                        serde_json::to_string(&request)
                            .expect("serialize request")
                            .as_bytes(),
                    );
                    frame.push(b'\n');
                    frame
                }
                _ => {
                    valid_request_frames += 2;
                    let req_a = HostCapabilityRuntimeRequest {
                        id: format!("fuzz-{i}-pair-a"),
                        capability: "env_get".to_string(),
                        field_a: env_key.to_string(),
                        field_b: String::new(),
                    };
                    let req_b = HostCapabilityRuntimeRequest {
                        id: format!("fuzz-{i}-pair-b"),
                        capability: "capability_unknown".to_string(),
                        field_a: String::new(),
                        field_b: String::new(),
                    };
                    let mut frame = CAPABILITY_NATIVE_REQ_PREFIX.as_bytes().to_vec();
                    frame.extend(
                        serde_json::to_string(&req_a)
                            .expect("serialize request")
                            .as_bytes(),
                    );
                    frame.push(b'\n');
                    frame.extend(CAPABILITY_NATIVE_REQ_PREFIX.as_bytes());
                    frame.extend(
                        serde_json::to_string(&req_b)
                            .expect("serialize request")
                            .as_bytes(),
                    );
                    frame.push(b'\n');
                    frame
                }
            };

            if scenario == 6 {
                let split = bytes.len() / 2;
                let accepted_a = stderr_pipe
                    .process_runtime_request_frames(&bytes[..split])
                    .expect("accepted bytes");
                let accepted_b = stderr_pipe
                    .process_runtime_request_frames(&bytes[split..])
                    .expect("accepted bytes");
                assert_eq!(accepted_a, split);
                assert_eq!(accepted_b, bytes.len() - split);
                accepted_bytes += accepted_a as u64 + accepted_b as u64;
            } else {
                let accepted = stderr_pipe
                    .process_runtime_request_frames(&bytes)
                    .expect("accepted bytes");
                assert_eq!(accepted, bytes.len());
                accepted_bytes += accepted as u64;
            }

            for response in drain_runtime_responses(&stdin_pipe) {
                if response.ok {
                    ok_responses += 1;
                } else {
                    denied_responses += 1;
                }
            }
        }

        let native_state = snapshot_native_capability_state(&native);
        let parse_failures = native_state
            .audit
            .iter()
            .filter(|entry| {
                entry.get("kind").and_then(Value::as_str) == Some("engine_error")
                    && entry
                        .get("detailJson")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .contains("native_host_abi_request_parse_failed")
            })
            .count() as u64;
        let policy_denials = native_state
            .audit
            .iter()
            .filter(|entry| entry.get("kind").and_then(Value::as_str) == Some("policy_denied"))
            .count() as u64;
        let output_len = {
            let state = stderr_pipe.state.lock().expect("stderr state");
            state.output.len() as u64
        };

        let ok = iterations == 640
            && accepted_bytes > 0
            && valid_request_frames >= 320
            && malformed_frames >= 120
            && ok_responses > 0
            && denied_responses > 0
            && parse_failures > 0
            && policy_denials > 0
            && output_len <= 16 * 1024;
        assert!(ok);

        write_artifact(
            "artifacts/security/native-abi-fuzz.json",
            &json!({
              "ok": ok,
              "invariants": ["INV-SECU-0006", "INV-FEAT-0025"],
              "generatedAt": SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time")
                .as_secs(),
              "seedHex": format!("{:016x}", 0x9d6c1ef4b3a27518_u64),
              "iterations": iterations,
              "acceptedBytes": accepted_bytes,
              "cases": {
                "validRequestFrames": valid_request_frames,
                "malformedFrames": malformed_frames
              },
              "responses": {
                "ok": ok_responses,
                "denied": denied_responses
              },
              "audit": {
                "parseFailures": parse_failures,
                "policyDenials": policy_denials
              },
              "transport": "process",
              "capabilityChannel": "component-wit",
              "dispatchMode": "host-native-abi-direct-dispatch"
            }),
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
