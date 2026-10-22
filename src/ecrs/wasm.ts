import type { ZXingModuleOverrides } from "zxing-wasm/reader";

/** Свой wasm, без загрузки с CDN. Модуль уже скомпилирован сборщиком Worker. */
export function zxingOverrides(wasm: WebAssembly.Module): ZXingModuleOverrides {
  if (!(wasm instanceof WebAssembly.Module)) {
    throw new Error("zxing wasm не собрался модулем");
  }
  const overrides = {
    instantiateWasm(
      imports: WebAssembly.Imports,
      receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) {
      const instance = new WebAssembly.Instance(wasm, imports);
      receive(instance, wasm);
      return instance.exports;
    },
  };
  return overrides as ZXingModuleOverrides;
}
