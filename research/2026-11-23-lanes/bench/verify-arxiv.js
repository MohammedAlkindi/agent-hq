// Cross-checks arXiv ids cited in lane files against the arXiv API (title, first-version date) and prints the lane's own context.
"use strict";
const fs = require("fs"), path = require("path");
const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => /^L\d.*\.md$/.test(f));
const ids = new Map(); // id -> [{file, ctx}]
for (const f of files) {
  const txt = fs.readFileSync(path.join(dir, f), "utf8");
  for (const m of txt.matchAll(/(?:arXiv:|arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5})/g)) {
    const id = m[1]; const s = Math.max(0, m.index - 90);
    const ctx = txt.slice(s, m.index + 20).replace(/\s+/g, " ");
    if (!ids.has(id)) ids.set(id, []);
    ids.get(id).push({ file: f.slice(0, 2), ctx });
  }
}
(async () => {
  const all = [...ids.keys()].sort(); const found = new Map();
  for (let i = 0; i < all.length; i += 20) {
    const batch = all.slice(i, i + 20);
    const r = await fetch("http://export.arxiv.org/api/query?max_results=40&id_list=" + batch.join(","));
    const xml = await r.text();
    for (const e of xml.split("<entry>").slice(1)) {
      const id = (/<id>https?:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/.exec(e) || [])[1];
      const title = ((/<title>([\s\S]*?)<\/title>/.exec(e) || [])[1] || "").replace(/\s+/g, " ").trim();
      const pub = (/<published>([^<]+)/.exec(e) || [])[1] || "";
      if (id) found.set(id, { title, pub: pub.slice(0, 10) });
    }
    await new Promise((r) => setTimeout(r, 3200)); // be polite to the API
  }
  let missing = 0;
  for (const id of all) {
    const f = found.get(id), refs = ids.get(id);
    if (!f || /^Error$/i.test(f.title)) missing++;
    console.log(`${id} | ${f ? f.pub + " | " + f.title.slice(0, 80) : "NOT FOUND ON ARXIV"} | lanes ${[...new Set(refs.map((x) => x.file))].join(",")} | ctx: ${refs[0].ctx.slice(-110)}`);
  }
  console.log(`\nchecked ${all.length}, not found/invalid: ${missing}`);
})();
