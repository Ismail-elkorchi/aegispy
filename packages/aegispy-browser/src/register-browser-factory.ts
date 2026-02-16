import { registerRuntimeFactory } from "../../aegispy-core/src/runtime/factory";
import { createBrowserRuntime } from "./runtime/browser-runtime";

registerRuntimeFactory("browser", createBrowserRuntime);
