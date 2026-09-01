import { readFile, access } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
const modules = new Map();

// Compile the actual pure/provider modules, not copied implementations. No
// emitted files, bundler, environment loading, or network access is required.
async function compiledUrl(filename, ancestors = [], moduleSources = {}, cache = modules) {
  const path = resolve(root, filename);
  const local = relative(root, path);
  if (local.startsWith("..") || isAbsolute(local)) throw new Error("Test module must be inside the repository.");
  if (ancestors.includes(path)) throw new Error(`Runtime import cycle in test loader: ${local}`);
  if (cache.has(path)) return cache.get(path);
  const compilation = (async () => {
    let source = ts.transpileModule(moduleSources[local] ?? await readFile(path, "utf8"), {
      fileName: path,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const syntax = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true);
    const imports = syntax.statements.filter(statement => (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier));
    for (const statement of imports) {
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
        if (!specifier.startsWith("node:")) source = source.replaceAll(`"${specifier}"`, JSON.stringify(import.meta.resolve(specifier)))
          .replaceAll(`'${specifier}'`, JSON.stringify(import.meta.resolve(specifier)));
        continue;
      }
      let dependency = specifier.startsWith("@/")
        ? resolve(root, specifier.slice(2)) : resolve(dirname(path), specifier);
      if (!/\.(?:ts|mjs|js)$/.test(dependency)) {
        const direct = `${dependency}.ts`;
        dependency = await access(direct).then(() => direct, () => resolve(dependency, "index.ts"));
      }
      const url = await compiledUrl(dependency, [...ancestors, path], moduleSources, cache);
      source = source.replaceAll(`"${specifier}"`, JSON.stringify(url)).replaceAll(`'${specifier}'`, JSON.stringify(url));
    }
    return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  })();
  cache.set(path, compilation);
  return compilation;
}

export async function loadTsModule(filename, { moduleSources } = {}) {
  return import(await compiledUrl(filename, [], moduleSources, moduleSources ? new Map() : modules));
}
