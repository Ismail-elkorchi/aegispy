import { registerRuntimeFactory } from "../../aegispy-core/src/runtime/factory";
import { createBrowserRuntimeFactory } from "./runtime/browser-runtime";

registerRuntimeFactory("browser", createBrowserRuntimeFactory);
