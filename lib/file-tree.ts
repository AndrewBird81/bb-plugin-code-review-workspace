export interface TreeFolder { kind: "folder"; name: string; path: string; children: TreeNode[] }
export interface TreeFile { kind: "file"; name: string; path: string }
export type TreeNode = TreeFolder | TreeFile;

/**
 * Changed files as a folder tree: in each folder, folders first and then files, each by name. A folder
 * whose only entry is another folder shows as one ("src/lib"), as GitHub's file tree does.
 */
export function fileTree(paths: readonly string[]): TreeNode[] {
  const root: TreeFolder = { kind: "folder", name: "", path: "", children: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let folder = root;
    parts.slice(0, -1).forEach((name, index) => {
      const at = parts.slice(0, index + 1).join("/");
      let next = folder.children.find((child): child is TreeFolder => child.kind === "folder" && child.path === at);
      if (!next) folder.children.push(next = { kind: "folder", name, path: at, children: [] });
      folder = next;
    });
    folder.children.push({ kind: "file", name: parts.at(-1)!, path });
  }
  return arrange(root).children;
}

function arrange(folder: TreeFolder): TreeFolder {
  const children = folder.children.map((child) => child.kind === "folder" ? arrange(child) : child);
  children.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1);
  // The root keeps its folders: it has no name to join them to.
  if (folder.path && children.length === 1 && children[0].kind === "folder") {
    const only = children[0];
    return { ...only, name: `${folder.name}/${only.name}` };
  }
  return { ...folder, children };
}

/** The first file the tree shows: a folder comes before its files, and isn't empty. */
export function firstFile(nodes: readonly TreeNode[]): string | undefined {
  const [first] = nodes;
  return first?.kind === "folder" ? firstFile(first.children) : first?.path;
}

/** The files whose path holds every word of the filter, in any case. */
export function filterPaths(paths: readonly string[], filter: string): string[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...paths];
  return paths.filter((path) => {
    const lower = path.toLowerCase();
    return words.every((word) => lower.includes(word));
  });
}
