import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';

export function previewTreeEntries(tree) {
  const invalid = message => Object.assign(new Error(message), {code:'bad_preview_tree',status:400});
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) throw invalid('Preview files must be a path-to-text object');
  const entries = Object.entries(tree);
  const names = new Set(entries.map(([name])=>name));
  for (const [name,content] of entries) {
    if (!name || name.includes('\0') || name.includes('\\') || path.posix.isAbsolute(name)
      || /^[a-z]:/i.test(name) || name.split('/').some(part=>!part || part==='.' || part==='..')) {
      throw invalid('Preview file path must be a canonical relative path');
    }
    if (typeof content !== 'string') throw invalid('Preview file contents must be text');
    const parts=name.split('/');
    for(let index=1;index<parts.length;index++) {
      if(names.has(parts.slice(0,index).join('/'))) throw invalid('Preview paths cannot be both a file and a directory');
    }
  }
  return entries;
}

export async function writePreviewTree(root,tree) {
  // Validate the whole request before writing even one file. The root is a fresh trusted
  // temporary directory; user paths must never escape it into the provisioner's host.
  const entries=previewTreeEntries(tree);
  for(const [relative,content] of entries) {
    if(relative==='vite.config.js') continue; // authoritative configuration comes from entrypoint
    const full=path.join(root,relative);
    await mkdir(path.dirname(full),{recursive:true});
    await writeFile(full,content,'utf8');
  }
}
