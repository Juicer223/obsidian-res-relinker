import { Plugin, TFile, Notice, TFolder } from "obsidian";

export default class ResRelinker extends Plugin {
  private timers = new Map<string, number>();
  private statusEl: HTMLElement | null = null;

  async onload() {
    new Notice("ResRelinker loaded (SAME-DIR _RES, COPY)");
    this.statusEl = this.addStatusBarItem();
    this.statusEl.setText("ResRelinker SAME-DIR (COPY)");

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension !== "md") return;

        this.debounce(file.path, 600, () => this.fixNote(file));
      })
    );

    console.log("[ResRelinker] loaded SAME-DIR (COPY)");
  }

  onunload() {
    console.log("[ResRelinker] unloaded");
  }

  private debounce(key: string, ms: number, fn: () => void) {
    const old = this.timers.get(key);
    if (old) window.clearTimeout(old);
    const id = window.setTimeout(fn, ms);
    this.timers.set(key, id);
  }

  private async ensureFolder(folderPath: string) {
    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (existing instanceof TFolder) return;

    // 递归创建
    const parts = folderPath.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      const af = this.app.vault.getAbstractFileByPath(cur);
      if (!af) await this.app.vault.createFolder(cur);
    }
  }

  private extractWikiEmbeds(content: string): string[] {
    // 抓 ![[...]] 形式
    const re = /!\[\[([^\]]+?)\]\]/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) out.push(m[1]);
    return out;
  }

  private stripAliasAndParams(link: string): string {
    // ![[path|alias]] 或 ![[path#heading]] 等，先只取 path 部分
    return link.split("|")[0].split("#")[0].trim();
  }

  private normalize(p: string): string {
    return p.replaceAll("\\", "/").replaceAll("//", "/");
  }

  private async fixNote(note: TFile) {
    try {
      // DEBUG：确认当前笔记真实路径
      console.log(
        "[ResRelinker] note.path =",
        note.path,
        "note.parent.path =",
        note.parent?.path
      );

      let content = await this.app.vault.read(note);
      const embeds = this.extractWikiEmbeds(content);
      if (embeds.length === 0) return;

      // ✅ 目标 _RES：必须和 note 同级
      const noteDir = note.parent?.path ?? "";
      const targetResRoot = noteDir ? this.normalize(`${noteDir}/_RES`) : "_RES";
      const targetFolderAbs = this.normalize(`${targetResRoot}/${note.basename}`);
      const targetLinkPrefix = `_RES/${note.basename}/`;

      console.log("[ResRelinker] targetFolderAbs =", targetFolderAbs);

      let changed = false;
      let copiedCount = 0;

      for (const raw of embeds) {
        const link = this.stripAliasAndParams(raw);

        // 只处理 _RES/xxx/filename
        const m = /^_RES\/([^\/]+)\/(.+)$/.exec(link);
        if (!m) continue;

        const currentFolder = m[1];
        const filename = m[2];

        // 已经在正确目录就跳过
        if (currentFolder === note.basename) continue;

        // 源文件：交给 Obsidian 解析真实文件
        const src = this.app.metadataCache.getFirstLinkpathDest(link, note.path);
        if (!(src instanceof TFile)) {
          console.log(
            "[ResRelinker] cannot resolve link to file:",
            link,
            "from note:",
            note.path
          );
          continue;
        }

        await this.ensureFolder(targetFolderAbs);

        const newPathAbs = this.normalize(`${targetFolderAbs}/${filename}`);

        // 目标已存在则跳过（防止覆盖/重复复制）
        if (this.app.vault.getAbstractFileByPath(newPathAbs)) continue;

        console.log("[ResRelinker] COPY from:", src.path, "to:", newPathAbs);

        // ✅ 复制文件（copy，不删除原文件）
        const data = await this.app.vault.readBinary(src);
        await this.app.vault.createBinary(newPathAbs, data);

        // ✅ 改写引用到新位置
        const newLink = `${targetLinkPrefix}${filename}`;
        const replacedRaw = raw.replace(link, newLink);
        content = content.replaceAll(`![[${raw}]]`, `![[${replacedRaw}]]`);

        changed = true;
        copiedCount++;
      }

      if (changed) {
        await this.app.vault.modify(note, content);
        if (this.statusEl) this.statusEl.setText(`SAME-DIR copied ${copiedCount}`);
        console.log(`[ResRelinker] ${note.path}: copied ${copiedCount}`);
      }
    } catch (e) {
      console.error("[ResRelinker] fixNote error:", e);
      new Notice("ResRelinker error, check console");
      if (this.statusEl) this.statusEl.setText("ResRelinker ERROR");
    }
  }
}