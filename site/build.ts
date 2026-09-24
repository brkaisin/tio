// Builds the documentation website: a single page with a sidebar, generated from README.md and docs/*.md.
// Usage: node site/build.ts [outDir]   (default outDir: site/out)

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked, Renderer, type Tokens } from "marked";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import bash from "highlight.js/lib/languages/bash";
import ts from "typescript";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("bash", bash);

const siteDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(siteDir, "..");
const outDir = resolve(process.argv[2] ?? join(siteDir, "out"));

type Package = { version: string; description: string; repository: { url: string } };
const pkg: Package = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

type Chapter = {
    slug: string;
    file: string;
    // overrides the h1 of the file
    title?: string;
    // h2 sections that make no sense on the website
    drop?: string[];
};

type Section = { id: string; html: string };
type RenderedChapter = Chapter & { sections: Section[] };

const chapters: Chapter[] = [
    {
        slug: "introduction",
        title: "Introduction",
        file: "README.md",
        drop: ["Documentation", "Running Tests", "License", "Contributing", "Todo"]
    },
    { slug: "getting-started", file: "docs/getting-started.md" },
    { slug: "core-concepts", file: "docs/core-concepts.md" },
    { slug: "fibers", file: "docs/fibers.md" },
    { slug: "error-handling", file: "docs/error-handling.md" },
    { slug: "dependency-injection", file: "docs/dependency-injection.md" }
];

const slugify = (text: string): string =>
    text
        .toLowerCase()
        .replace(/<[^>]*>/g, "")
        .replace(/&[a-z]+;|&#\d+;/g, "")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");

const escapeHtml = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Removes the given h2 sections (heading included, up to the next h2) and the "Next Steps" section of every chapter.
function dropSections(markdown: string, titles: string[]): string {
    const toDrop = new Set([...titles, "Next Steps"]);
    const out: string[] = [];
    let dropping = false;
    let inFence = false;
    for (const line of markdown.split("\n")) {
        if (line.startsWith("```")) inFence = !inFence;
        if (!inFence && line.startsWith("## ")) dropping = toDrop.has(line.slice(3).trim());
        if (!dropping) out.push(line);
    }
    return out.join("\n");
}

// All the chapters are on the same page, so heading ids must be unique across chapters.
const usedIds = new Set(chapters.map((c) => c.slug));
const uniqueId = (base: string, chapterSlug: string): string => {
    let id = usedIds.has(base) ? `${chapterSlug}-${base}` : base;
    for (let i = 2; usedIds.has(id); i++) id = `${chapterSlug}-${base}-${i}`;
    usedIds.add(id);
    return id;
};

// the chapter being rendered
let current: RenderedChapter;

const marked = new Marked({
    gfm: true,
    renderer: {
        heading({ tokens, depth }: Tokens.Heading): string {
            const html = this.parser.parseInline(tokens);
            if (depth === 1) {
                return `<h1 id="${current.slug}"><a class="anchor" href="#${current.slug}">${html}</a></h1>\n`;
            }
            const id = uniqueId(slugify(html), current.slug);
            if (depth === 2) current.sections.push({ id, html });
            return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${html}</a></h${depth}>\n`;
        },
        code({ text, lang }: Tokens.Code): string {
            const language = lang === "ts" ? "typescript" : lang;
            const highlighted =
                language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : escapeHtml(text);
            return `<pre><code class="hljs${language ? ` language-${language}` : ""}">${highlighted}</code></pre>\n`;
        },
        table(token: Tokens.Table): string {
            // wrap tables so that they scroll horizontally on small screens
            return `<div class="table-wrapper">${Renderer.prototype.table.call(this, token)}</div>\n`;
        },
        link({ href, title, tokens }: Tokens.Link): string {
            const text = this.parser.parseInline(tokens);
            // links between docs become anchors on the page
            const doc = href.match(/^(?:\.\/)?(?:docs\/)?([\w-]+)\.md(#.*)?$/);
            if (doc) href = doc[2] ?? `#${doc[1]}`;
            else if (href === "LICENSE.txt") href = `${pkg.repository.url}/blob/master/LICENSE.txt`;
            const external = /^https?:/.test(href) ? ` target="_blank" rel="noopener"` : "";
            return `<a href="${href}"${title ? ` title="${escapeHtml(title)}"` : ""}${external}>${text}</a>`;
        }
    }
});

const toc: RenderedChapter[] = [];

const content = chapters
    .map((chapter) => {
        current = { ...chapter, sections: [] };
        let markdown = dropSections(readFileSync(join(root, chapter.file), "utf8"), chapter.drop ?? []);
        if (chapter.title) markdown = markdown.replace(/^# .*$/m, `# ${chapter.title}`);
        // GitHub emoji shortcodes
        markdown = markdown.replaceAll(":warning:", "⚠️");
        const html = marked.parse(markdown, { async: false });
        current.title ??= markdown.match(/^# (.*)$/m)?.[1] ?? chapter.slug;
        toc.push(current);
        return `<section class="chapter">\n${html}</section>`;
    })
    .join("\n");

const sidebar = toc
    .map(
        (c) => `<li class="toc-chapter">
    <a href="#${c.slug}">${escapeHtml(c.title!)}</a>
    <ul>${c.sections.map((s) => `\n        <li><a href="#${s.id}">${s.html}</a></li>`).join("")}
    </ul>
</li>`
    )
    .join("\n");

const page = readFileSync(join(siteDir, "template.html"), "utf8")
    .replaceAll("{{version}}", pkg.version)
    .replaceAll("{{description}}", escapeHtml(pkg.description))
    .replaceAll("{{repository}}", pkg.repository.url)
    .replace("{{sidebar}}", () => sidebar)
    .replace("{{content}}", () => content);

// the browser script is written in TypeScript too
const script = ts.transpileModule(readFileSync(join(siteDir, "script.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None, removeComments: true }
}).outputText;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "index.html"), page);
writeFileSync(join(outDir, "script.js"), script);
copyFileSync(join(siteDir, "style.css"), join(outDir, "style.css"));
writeFileSync(join(outDir, ".nojekyll"), "");

console.log(`Documentation website built in ${outDir}`);
