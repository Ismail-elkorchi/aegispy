import { registerRuntimeFactory } from "../../aegispy-core/src/runtime/factory";
import { createNodeRuntime } from "./runtime/node-runtime";

registerRuntimeFactory("node", createNodeRuntime);
