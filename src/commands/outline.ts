import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Command } from "commander";
import type * as TS from "typescript";
import type { EmitContext } from "../commander.ts";
import { resolveBinName } from "../core/config.ts";

/**
 * `typescript` is a devDependency, not a runtime dependency, so it is loaded
 * lazily here and only when outlining a TS/JS file. A static top-level import
 * would make the whole CLI fail to boot for an end user who installed harnery
 * without dev deps (every command is registered at startup). PHP/Python
 * outlines use regex and never touch this.
 */
async function loadTypeScript(): Promise<typeof TS> {
  try {
    return (await import("typescript")) as unknown as typeof TS;
  } catch {
    throw new Error(
      "outlining TS/JS files needs the `typescript` package; install it (npm i -D typescript) or use outline on PHP/Python files",
    );
  }
}

/**
 * `harn outline <file>`: print the structural skeleton of a code file (imports
 * + top-level decls + line numbers). TS/JS/TSX/JSX use the TypeScript compiler
 * AST; PHP and Python use a regex pass. Token-efficient substitute for reading
 * a whole large file just to find one symbol.
 *
 * For markdown files, dispatch to `harn toc`.
 */

interface OutlineOpts {
  json?: boolean;
  exportsOnly?: boolean;
  imports?: boolean; // Commander sets to false on --no-imports
  members?: boolean; // Commander sets to false on --no-members
}

interface SymbolEntry {
  kind: string;
  name: string;
  signature?: string;
  line: number;
  exported?: boolean;
  members?: SymbolEntry[];
}

interface OutlineResult {
  file: string;
  language: string;
  total_lines: number;
  imports: string[];
  symbols: SymbolEntry[];
}

export function registerOutlineCommand(program: Command, emit: EmitContext): void {
  program
    .command("outline <file>")
    .description(
      `Print the structural skeleton of a code file (imports + top-level decls + line numbers). Supports TS/JS/TSX/JSX (AST), PHP/Python (regex). Use \`${resolveBinName()} toc\` for markdown.`,
    )
    .option("--json", "Structured JSON envelope")
    .option("--exports-only", "Only show exported symbols")
    .option("--no-imports", "Skip the imports summary block")
    .option("--no-members", "Don't expand class/interface members")
    .action(async (file: string, opts: OutlineOpts) => {
      try {
        const result = await runOutline(file, opts);
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(result);
          return;
        }
        emit.text(`${renderOutline(result, opts)}\n`);
      } catch (err) {
        emit.error({ code: "outline_failed", message: (err as Error).message });
        process.exit(1);
      }
    });
}

async function runOutline(file: string, opts: OutlineOpts): Promise<OutlineResult> {
  const absPath = resolve(file);
  if (!existsSync(absPath)) throw new Error(`no such file: ${file}`);

  const content = readFileSync(absPath, "utf8");
  const total_lines = content.split("\n").length;
  const ext = extname(absPath).toLowerCase();

  let language = "";
  let parsed: { imports: string[]; symbols: SymbolEntry[] };

  if ([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(ext)) {
    language = ext.slice(1);
    parsed = await outlineTypeScript(content, absPath, ext);
  } else if (ext === ".php") {
    language = "php";
    parsed = outlinePhp(content);
  } else if (ext === ".py") {
    language = "python";
    parsed = outlinePython(content);
  } else if ([".md", ".mdx"].includes(ext)) {
    throw new Error(`use \`${resolveBinName()} toc ${file}\` for markdown files`);
  } else {
    throw new Error(
      `unsupported file type: ${ext || "(no extension)"} (supported: ts/tsx/js/jsx/php/py)`,
    );
  }

  if (opts.exportsOnly) {
    parsed.symbols = parsed.symbols.filter((s) => s.exported);
  }

  return {
    file,
    language,
    total_lines,
    imports: parsed.imports,
    symbols: parsed.symbols,
  };
}

async function outlineTypeScript(
  content: string,
  path: string,
  ext: string,
): Promise<{ imports: string[]; symbols: SymbolEntry[] }> {
  const ts = await loadTypeScript();
  const isTsx = ext === ".tsx" || ext === ".jsx";
  const scriptKind = isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind);

  const imports: string[] = [];
  const symbols: SymbolEntry[] = [];

  const lineOf = (node: TS.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const text = (node: TS.Node) =>
    content.slice(node.getStart(source), node.getEnd()).replace(/\s+/g, " ").trim();
  const isExported = (node: TS.Node): boolean => {
    const mods = (node as { modifiers?: ReadonlyArray<TS.ModifierLike> }).modifiers;
    return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  };

  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const moduleSpec = (stmt.moduleSpecifier as TS.StringLiteral).text;
      const clause = stmt.importClause;
      const isTypeOnly = clause?.isTypeOnly ? "type " : "";
      let what = "";
      if (clause?.name) what = clause.name.text;
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          what = `${what ? `${what}, ` : ""}* as ${clause.namedBindings.name.text}`;
        } else {
          const names = clause.namedBindings.elements.map((e) => e.name.text).join(", ");
          what = `${what ? `${what}, ` : ""}{${names}}`;
        }
      }
      imports.push(`${isTypeOnly}${what || "(side-effect)"} from "${moduleSpec}"`);
      continue;
    }

    const exported = isExported(stmt);

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      symbols.push({
        kind: "function",
        name: stmt.name.text,
        signature: renderFnSig(ts, stmt, content, source),
        line: lineOf(stmt),
        exported,
      });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const heritage = (stmt.heritageClauses || [])
        .map(
          (h) =>
            (h.token === ts.SyntaxKind.ExtendsKeyword ? "extends " : "implements ") +
            h.types.map((t) => text(t.expression)).join(", "),
        )
        .join(" ");
      const members: SymbolEntry[] = [];
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.name) {
          members.push({
            kind: "method",
            name: (member.name as TS.Identifier).text || text(member.name),
            signature: renderFnSig(ts, member, content, source),
            line: lineOf(member),
          });
        } else if (ts.isConstructorDeclaration(member)) {
          members.push({
            kind: "method",
            name: "constructor",
            signature: renderFnSig(ts, member, content, source),
            line: lineOf(member),
          });
        } else if (ts.isPropertyDeclaration(member) && member.name) {
          members.push({
            kind: "property",
            name: (member.name as TS.Identifier).text || text(member.name),
            signature: member.type ? `: ${text(member.type)}` : "",
            line: lineOf(member),
          });
        }
      }
      symbols.push({
        kind: "class",
        name: stmt.name.text,
        signature: heritage,
        line: lineOf(stmt),
        exported,
        members,
      });
    } else if (ts.isInterfaceDeclaration(stmt)) {
      const heritage = (stmt.heritageClauses || [])
        .flatMap((h) => h.types.map((t) => text(t.expression)))
        .join(", ");
      const members: SymbolEntry[] = [];
      for (const member of stmt.members) {
        if (ts.isPropertySignature(member) && member.name) {
          members.push({
            kind: "property",
            name: (member.name as TS.Identifier).text || text(member.name),
            signature: member.type ? `: ${text(member.type)}` : "",
            line: lineOf(member),
          });
        } else if (ts.isMethodSignature(member) && member.name) {
          members.push({
            kind: "method",
            name: (member.name as TS.Identifier).text || text(member.name),
            signature: renderFnSig(ts, member, content, source),
            line: lineOf(member),
          });
        }
      }
      symbols.push({
        kind: "interface",
        name: stmt.name.text,
        signature: heritage ? `extends ${heritage}` : "",
        line: lineOf(stmt),
        exported,
        members,
      });
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      const sigText = text(stmt.type);
      symbols.push({
        kind: "type",
        name: stmt.name.text,
        signature: `= ${sigText.slice(0, 80)}${sigText.length > 80 ? "…" : ""}`,
        line: lineOf(stmt),
        exported,
      });
    } else if (ts.isEnumDeclaration(stmt)) {
      symbols.push({
        kind: "enum",
        name: stmt.name.text,
        line: lineOf(stmt),
        exported,
        members: stmt.members.map((m) => ({
          kind: "enumMember",
          name: (m.name as TS.Identifier).text || text(m.name),
          line: lineOf(m),
        })),
      });
    } else if (ts.isVariableStatement(stmt)) {
      const flags = stmt.declarationList.flags;
      const isConst = (flags & ts.NodeFlags.Const) !== 0;
      const isLet = (flags & ts.NodeFlags.Let) !== 0;
      const kind = isConst ? "const" : isLet ? "let" : "var";
      const stmtExported = isExported(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        let sig = "";
        if (decl.type) sig = `: ${text(decl.type)}`;
        else if (
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          sig = renderFnSig(ts, decl.initializer, content, source);
        }
        symbols.push({
          kind,
          name: decl.name.text,
          signature: sig,
          line: lineOf(decl),
          exported: stmtExported,
        });
      }
    } else if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        const names = stmt.exportClause.elements.map((e) => e.name.text).join(", ");
        const fromText = stmt.moduleSpecifier
          ? ` from "${(stmt.moduleSpecifier as TS.StringLiteral).text}"`
          : "";
        symbols.push({
          kind: "re-export",
          name: `{${names}}${fromText}`,
          line: lineOf(stmt),
          exported: true,
        });
      } else if (stmt.moduleSpecifier) {
        symbols.push({
          kind: "re-export",
          name: `* from "${(stmt.moduleSpecifier as TS.StringLiteral).text}"`,
          line: lineOf(stmt),
          exported: true,
        });
      }
    } else if (ts.isModuleDeclaration(stmt) && stmt.name) {
      symbols.push({
        kind: "namespace",
        name: (stmt.name as TS.Identifier).text || text(stmt.name),
        line: lineOf(stmt),
        exported,
      });
    }
  }

  return { imports, symbols };
}

function renderFnSig(
  ts: typeof TS,
  fn: TS.FunctionLikeDeclarationBase | TS.MethodSignature,
  content: string,
  source: TS.SourceFile,
): string {
  const params = (fn.parameters || [])
    .map((p) => {
      const name = ts.isIdentifier(p.name)
        ? p.name.text
        : content.slice(p.name.getStart(source), p.name.getEnd());
      const type = p.type
        ? content.slice(p.type.getStart(source), p.type.getEnd()).replace(/\s+/g, " ").trim()
        : "";
      const optional = p.questionToken ? "?" : "";
      return type ? `${name}${optional}: ${type}` : `${name}${optional}`;
    })
    .join(", ");
  const ret = fn.type
    ? `: ${content.slice(fn.type.getStart(source), fn.type.getEnd()).replace(/\s+/g, " ").trim()}`
    : "";
  return `(${params})${ret}`;
}

function outlinePhp(content: string): { imports: string[]; symbols: SymbolEntry[] } {
  const lines = content.split("\n");
  const imports: string[] = [];
  const symbols: SymbolEntry[] = [];
  let currentContainer: SymbolEntry | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();
    const isIndented = /^[ \t]/.test(line);

    if (
      trimmed === "" ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    )
      continue;

    const nsMatch = trimmed.match(/^namespace\s+([\w\\]+)\s*;/);
    if (nsMatch && !isIndented) {
      symbols.push({ kind: "namespace", name: nsMatch[1], line: lineNum });
      continue;
    }
    const useMatch = trimmed.match(/^use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/);
    if (useMatch && !isIndented) {
      imports.push(useMatch[2] ? `${useMatch[1]} as ${useMatch[2]}` : useMatch[1]);
      continue;
    }
    if (!isIndented) {
      const classMatch = trimmed.match(
        /^(?:abstract\s+|final\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/,
      );
      if (classMatch) {
        currentContainer = {
          kind: "class",
          name: classMatch[1],
          signature: [
            classMatch[2] ? `extends ${classMatch[2]}` : "",
            classMatch[3] ? `implements ${classMatch[3].trim()}` : "",
          ]
            .filter(Boolean)
            .join(" "),
          line: lineNum,
          members: [],
        };
        symbols.push(currentContainer);
        continue;
      }
      const interfaceMatch = trimmed.match(/^interface\s+(\w+)/);
      if (interfaceMatch) {
        currentContainer = {
          kind: "interface",
          name: interfaceMatch[1],
          line: lineNum,
          members: [],
        };
        symbols.push(currentContainer);
        continue;
      }
      const traitMatch = trimmed.match(/^trait\s+(\w+)/);
      if (traitMatch) {
        currentContainer = { kind: "trait", name: traitMatch[1], line: lineNum, members: [] };
        symbols.push(currentContainer);
        continue;
      }
    }
    const fnMatch = trimmed.match(
      /^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
    );
    if (fnMatch) {
      const entry: SymbolEntry = {
        kind: isIndented && currentContainer ? "method" : "function",
        name: fnMatch[1],
        signature: `(${fnMatch[2].trim()})`,
        line: lineNum,
      };
      if (isIndented && currentContainer) {
        currentContainer.members!.push(entry);
      } else {
        symbols.push(entry);
      }
    }
  }

  return { imports, symbols };
}

function outlinePython(content: string): { imports: string[]; symbols: SymbolEntry[] } {
  const lines = content.split("\n");
  const imports: string[] = [];
  const symbols: SymbolEntry[] = [];
  let currentClass: SymbolEntry | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();
    const indent = line.match(/^ */)![0].length;

    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const importMatch = trimmed.match(/^import\s+(.+)$/);
    const fromMatch = trimmed.match(/^from\s+(\S+)\s+import\s+(.+)$/);
    if (importMatch && indent === 0) {
      imports.push(importMatch[1]);
      continue;
    }
    if (fromMatch && indent === 0) {
      imports.push(`${fromMatch[2].trim()} from ${fromMatch[1]}`);
      continue;
    }

    const classMatch = trimmed.match(/^class\s+(\w+)(?:\(([^)]*)\))?:/);
    if (classMatch && indent === 0) {
      currentClass = {
        kind: "class",
        name: classMatch[1],
        signature: classMatch[2] ? `(${classMatch[2]})` : "",
        line: lineNum,
        members: [],
      };
      symbols.push(currentClass);
      continue;
    }

    const methodMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
    if (methodMatch) {
      if (indent === 0) {
        symbols.push({
          kind: "function",
          name: methodMatch[1],
          signature: `(${methodMatch[2].trim()})`,
          line: lineNum,
        });
        currentClass = null;
      } else if (currentClass) {
        currentClass.members!.push({
          kind: "method",
          name: methodMatch[1],
          signature: `(${methodMatch[2].trim()})`,
          line: lineNum,
        });
      }
      continue;
    }

    if (indent === 0 && trimmed.length > 0 && currentClass) {
      currentClass = null;
    }
  }

  return { imports, symbols };
}

function renderOutline(r: OutlineResult, opts: OutlineOpts): string {
  const lines: string[] = [];
  const symbolCount = r.symbols.length;
  lines.push(
    `outline · ${r.file} (${r.language}, ${r.total_lines} lines, ${symbolCount} top-level symbol${symbolCount === 1 ? "" : "s"})`,
  );

  if (opts.imports !== false && r.imports.length > 0) {
    lines.push("");
    if (r.imports.length <= 4) {
      lines.push(`imports: ${r.imports.join(" · ")}`);
    } else {
      lines.push(`imports (${r.imports.length}):`);
      for (const imp of r.imports) lines.push(`  ${imp}`);
    }
  }

  if (r.symbols.length > 0) {
    lines.push("");
    for (const sym of r.symbols) {
      lines.push(renderSymbol(sym, 0, opts));
    }
  } else {
    lines.push("");
    lines.push("(no top-level symbols)");
  }

  return lines.join("\n");
}

function renderSymbol(s: SymbolEntry, depth: number, opts: OutlineOpts): string {
  const indent = "  ".repeat(depth);
  const lineMark = `L${s.line}`.padEnd(6);
  const exp = s.exported ? "★ " : "  ";
  const kindAbbr = kindToAbbr(s.kind);
  const sig = s.signature ? ` ${s.signature}` : "";
  const head = `${indent}${exp}${lineMark} ${kindAbbr} ${s.name}${sig}`;

  if (opts.members !== false && s.members && s.members.length > 0) {
    return [head, ...s.members.map((m) => renderSymbol(m, depth + 1, opts))].join("\n");
  }
  return head;
}

function kindToAbbr(kind: string): string {
  switch (kind) {
    case "function":
      return "fn  ";
    case "class":
      return "cl  ";
    case "interface":
      return "if  ";
    case "type":
      return "ty  ";
    case "const":
      return "ct  ";
    case "let":
      return "let ";
    case "var":
      return "var ";
    case "enum":
      return "en  ";
    case "enumMember":
      return "em  ";
    case "method":
      return "mt  ";
    case "property":
      return "pr  ";
    case "namespace":
      return "ns  ";
    case "trait":
      return "tr  ";
    case "re-export":
      return "rx  ";
    default:
      return kind.slice(0, 4).padEnd(4);
  }
}
