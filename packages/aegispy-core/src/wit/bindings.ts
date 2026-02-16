export interface WITFsRead {
  path: string;
}

export interface WITFsWrite {
  path: string;
  dataUtf8: string;
}

export interface WITHttpGet {
  url: string;
}

export interface WITCapabilityResult {
  ok: boolean;
  payloadUtf8: string;
  errorCode: string;
}

export interface WITHost {
  fs_read(input: WITFsRead): WITCapabilityResult;
  fs_write(input: WITFsWrite): WITCapabilityResult;
  http_get(input: WITHttpGet): WITCapabilityResult;
}
