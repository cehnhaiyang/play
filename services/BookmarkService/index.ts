/**
 * 书签树的**纯操作**（渲染层侧）。
 *
 * ============================================================================
 * 为什么单独一个文件
 * ============================================================================
 *
 * 书签从扁平数组改成树之后，所有增删改都变成"在树上按 id 找节点 → 在正确的
 * 层级上替换"。这类操作有一个共同的坏味道：**用错层级时不会报错，只会静默
 * 丢数据或把子节点整片覆盖掉**。
 *
 * 典型事故是"移动文件夹到自己的子孙下面"——朴素的递归实现会先把目标从树上
 * 摘下来，再往它自己的子树里插，结果是那棵子树连同自己一起从书签里消失。
 * 界面上表现为"拖了一下，一整组书签没了"，且不可撤销。
 *
 * 所以这里的每个函数都是纯函数，输入输出都是新对象，并且对非法操作**返回原树**
 * 而不是抛异常 —— 拖拽是高频交互，抛异常会打断整个渲染。
 */

import type { BookmarkNode, BookmarkTree } from '../../meta';

/* ========================================================================== */
/*                                  查找                                       */
/* ========================================================================== */

/** 深度优先查找节点 */
export function findNode(root: BookmarkNode, id: string): BookmarkNode | null {
    if (!root || !id) return null;
    if (root.id === id) return root;
    for (const child of root.children || []) {
        const hit = findNode(child, id);
        if (hit) return hit;
    }
    return null;
}

/**
 * 找节点的父节点。
 *
 * 返回 null 有两种情况：节点就是根，或者根本不存在。调用方需要区分时
 * 自己比对 root.id —— 这里不额外造一个哨兵值，那会让"根"和"没找到"
 * 混成一个概念，而它们的处理方式完全不同（根不能删、不存在无需处理）。
 */
export function findParent(root: BookmarkNode, id: string): BookmarkNode | null {
    if (!root || !id) return null;
    for (const child of root.children || []) {
        if (child.id === id) return root;
        const hit = findParent(child, id);
        if (hit) return hit;
    }
    return null;
}

/** 节点所在的层级深度（根为 0） */
export function nodeDepth(root: BookmarkNode, id: string, depth = 0): number {
    if (!root || !id) return -1;
    if (root.id === id) return depth;
    for (const child of root.children || []) {
        const hit = nodeDepth(child, id, depth + 1);
        if (hit >= 0) return hit;
    }
    return -1;
}

/**
 * id 是否是 ancestorId 的后代（含自身）。
 *
 * 这是"不能把文件夹拖进自己里面"这条规则的判据。抽出来单独测，是因为
 * 这个判据一旦写反（比如漏掉"含自身"），症状正是上面说的整片子树消失。
 */
export function isDescendant(ancestor: BookmarkNode, id: string): boolean {
    if (!ancestor || !id) return false;
    if (ancestor.id === id) return true;
    for (const child of ancestor.children || []) {
        if (isDescendant(child, id)) return true;
    }
    return false;
}

/* ========================================================================== */
/*                                  遍历                                       */
/* ========================================================================== */

/** 展平出所有 url 节点（供"是否已收藏"判断与书签管理器使用） */
export function flattenUrls(root: BookmarkNode, trail: string[] = []): Array<{ node: BookmarkNode; folderPath: string[] }> {
    const out: Array<{ node: BookmarkNode; folderPath: string[] }> = [];
    if (!root) return out;
    for (const child of root.children || []) {
        if (child.type === 'url') {
            out.push({ node: child, folderPath: trail });
        } else {
            out.push(...flattenUrls(child, [...trail, child.title]));
        }
    }
    return out;
}

/** 树里所有节点（含文件夹）的条数 */
export function countNodes(root: BookmarkNode): number {
    if (!root) return 0;
    let total = 0;
    for (const child of root.children || []) {
        total += 1 + countNodes(child);
    }
    return total;
}

/** 收集所有文件夹（供"移动到…"菜单与左侧树使用） */
export function collectFolders(root: BookmarkNode, depth = 0): Array<{ node: BookmarkNode; depth: number }> {
    const out: Array<{ node: BookmarkNode; depth: number }> = [];
    if (!root) return out;
    for (const child of root.children || []) {
        if (child.type === 'folder') {
            out.push({ node: child, depth });
            out.push(...collectFolders(child, depth + 1));
        }
    }
    return out;
}

/* ========================================================================== */
/*                                  变更                                       */
/* ========================================================================== */

/**
 * 不可变替换：把树上 id 为 targetId 的节点换成 replacer 的返回值。
 *
 * 路径上每一层都新建对象，没走到的分支原样返回 —— 这样 React 的 memo
 * 才能按引用判断出哪一支真的变了。
 */
export function replaceNode(
    root: BookmarkNode,
    targetId: string,
    replacer: (node: BookmarkNode) => BookmarkNode
): BookmarkNode {
    if (!root) return root;
    if (root.id === targetId) return replacer(root);
    if (!root.children || root.children.length === 0) return root;

    let changed = false;
    const next = root.children.map((child) => {
        const replaced = replaceNode(child, targetId, replacer);
        if (replaced !== child) changed = true;
        return replaced;
    });
    return changed ? { ...root, children: next } : root;
}

/** 不可变移除：删掉 id 为 targetId 的节点（连同其子树） */
export function removeNode(root: BookmarkNode, targetId: string): BookmarkNode {
    if (!root || !root.children) return root;
    let changed = false;
    const next: BookmarkNode[] = [];
    for (const child of root.children) {
        if (child.id === targetId) { changed = true; continue; }
        const pruned = removeNode(child, targetId);
        if (pruned !== child) changed = true;
        next.push(pruned);
    }
    return changed ? { ...root, children: next } : root;
}

/**
 * 把节点插到 parentId 下面。
 *
 * index 语义是「插到第 N 个位置之前」。越界一律**夹到 [0, length]**：
 *   - `> length` → 追加到末尾；
 *   - `< 0`      → 插到最前。
 *
 * 负值夹到 0 而不是 length，是因为这两种夹法方向相反：负值通常来自
 * "下标算错了"，把它变成"追加到末尾"会让本该在开头的条目静默跑到最后，
 * 而夹到 0 至少方向是对的。这类"静默换了语义"正是本文件要避免的。
 */
export function insertNode(
    root: BookmarkNode,
    parentId: string,
    node: BookmarkNode,
    index?: number
): BookmarkNode {
    return replaceNode(root, parentId, (parent) => {
        const children = [...(parent.children || [])];
        const at = index == null ? children.length : Math.min(children.length, Math.max(0, index));
        children.splice(at, 0, node);
        return { ...parent, children };
    });
}

/**
 * 移动节点到另一个文件夹。
 *
 * **三道闸，缺一不可**：
 *   1. 源节点与目标文件夹都必须存在；
 *   2. 目标不能是源自身或源的后代 —— 否则会把子树挂到自己里面，
 *      整棵子树从书签里消失（这是本文件最需要防的事故）；
 *   3. 目标必须是文件夹（url 节点不能有孩子）。
 *
 * 任何一道不过就**原样返回**（引用相等），调用方据此知道操作没发生。
 */
export function moveNode(tree: BookmarkTree, nodeId: string, targetFolderId: string, index?: number): BookmarkTree {
    const located = locate(tree, nodeId);
    if (!located) return tree;

    const target = locate(tree, targetFolderId);
    if (!target || target.node.type !== 'folder') return tree;

    // 目标落在源自己或源的子树里 → 拒绝
    if (isDescendant(located.node, targetFolderId)) return tree;

    // 同父同位置的空操作也直接返回，避免白白产生新引用
    if (located.parent && located.parent.id === targetFolderId) {
        const siblings = located.parent.children || [];
        const from = siblings.findIndex((c) => c.id === nodeId);
        const to = index == null ? siblings.length - 1 : index;
        if (from === to) return tree;
    }

    const detached = detach(tree, nodeId);
    if (!detached) return tree;

    const inserted = insertNode(detached.bar, targetFolderId, located.node, index);
    const insertedOther = inserted === detached.bar
        ? insertNode(detached.other, targetFolderId, located.node, index)
        : inserted;

    // 目标在 bar 里，other 原样；否则看 other 有没有变
    if (inserted !== detached.bar) return { bar: inserted, other: detached.other };
    if (insertedOther !== detached.other) return { bar: detached.bar, other: insertedOther };
    return tree;   // 目标找不到（理论上不会走到，locate 已经确认过）
}

/** 定位节点及其父节点，并标明它在哪个根下 */
function locate(tree: BookmarkTree, id: string): { node: BookmarkNode; parent: BookmarkNode | null } | null {
    for (const root of [tree.bar, tree.other]) {
        if (root.id === id) return { node: root, parent: null };
        const node = findNode(root, id);
        if (node) return { node, parent: findParent(root, id) };
    }
    return null;
}

/** 从树上摘掉一个节点，返回新树（摘不到返回 null） */
function detach(tree: BookmarkTree, id: string): BookmarkTree | null {
    const inBar = findNode(tree.bar, id);
    if (inBar) return { bar: removeNode(tree.bar, id), other: tree.other };
    const inOther = findNode(tree.other, id);
    if (inOther) return { bar: tree.bar, other: removeNode(tree.other, id) };
    return null;
}

/* ========================================================================== */
/*                                  构造                                       */
/* ========================================================================== */

/** 建一个空文件夹 */
export function makeFolder(id: string, title: string, createdAt: number = Date.now()): BookmarkNode {
    return { id, type: 'folder', title, children: [], createdAt };
}

/** 建一个网址节点 */
export function makeUrlNode(
    id: string,
    url: string,
    title: string,
    createdAt: number = Date.now(),
    icon?: string
): BookmarkNode {
    return { id, type: 'url', title: title || url, url, createdAt, ...(icon ? { icon } : {}) };
}

/**
 * 空的默认书签树（首次启动用）。
 *
 * 两个根都是空文件夹：预置几个"常用网站"看着友好，实际是替用户做了决定 ——
 * 他既没访问过那些站点，也没打算把它们放在书签栏上，第一条要做的操作就是删。
 * 空栏配合「从 Edge 导入」，用户拿到的是自己真实的收藏夹。
 */
export function makeDefaultTree(): BookmarkTree {
    return {
        bar: makeFolder('bar', '收藏夹栏', 0),
        other: makeFolder('other', '其他收藏夹', 0),
    };
}

/* ========================================================================== */
/*                                校验与归一化                                  */
/* ========================================================================== */

/**
 * 校验并归一化一个节点（读盘数据可能是旧版本或被手改过）。
 *
 * title 是**必填展示字段**，缺了就用 url 兜底 —— 书签栏、下拉菜单、
 * 管理器三处都直接渲染 node.title，空值会留下一条没有文字的条目。
 * 坏数据在入口就修好，而不是到渲染时才发现。
 */
export function normalizeNode(raw: unknown, fallbackId: () => string): BookmarkNode | null {
    if (!raw || typeof raw !== 'object') return null;
    const node = raw as Partial<BookmarkNode>;
    const id = typeof node.id === 'string' && node.id ? node.id : fallbackId();
    const title = typeof node.title === 'string' && node.title.trim() ? node.title : '';

    if (node.type === 'folder') {
        const children: BookmarkNode[] = [];
        for (const child of Array.isArray(node.children) ? node.children : []) {
            const normalized = normalizeNode(child, fallbackId);
            if (normalized) children.push(normalized);
        }
        return { id, type: 'folder', title: title || '未命名文件夹', children, createdAt: toTime(node.createdAt) };
    }

    const url = typeof node.url === 'string' ? node.url.trim() : '';
    if (!url) return null;

    const icon = typeof node.icon === 'string' && node.icon ? node.icon : undefined;
    return {
        id,
        type: 'url',
        title: title || url,
        url,
        createdAt: toTime(node.createdAt),
        ...(icon ? { icon } : {}),
    };
}

function toTime(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * 归一化整棵树。
 *
 * 两个根缺失时补空文件夹而不是返回 null —— 界面对"没有书签"和"树坏了"
 * 的处理是一样的（都显示空状态），但返回 null 会让上层多出无数个判空。
 */
export function normalizeTree(raw: unknown, fallbackId: () => string): BookmarkTree {
    const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<BookmarkTree>;
    const bar = normalizeNode(source.bar, fallbackId);
    const other = normalizeNode(source.other, fallbackId);
    return {
        bar: bar && bar.type === 'folder' ? bar : makeFolder('bar', '收藏夹栏', 0),
        other: other && other.type === 'folder' ? other : makeFolder('other', '其他收藏夹', 0),
    };
}

/**
 * 从扁平书签数组迁移到树（v1 → v2）。
 *
 * 老版本存的是 `Bookmark[]`，没有文件夹概念。迁移时全部平铺进「收藏夹栏」，
 * 顺序保持不变 —— 用户看到的是"书签都还在"，而不是"升级后少了东西"。
 */
export function migrateFlatBookmarks(list: unknown, fallbackId: () => string): BookmarkTree {
    const tree = { bar: makeFolder('bar', '收藏夹栏', 0), other: makeFolder('other', '其他收藏夹', 0) };
    if (!Array.isArray(list)) return tree;

    const children: BookmarkNode[] = [];
    for (const item of list) {
        const node = normalizeNode({ ...(item as object), type: 'url' }, fallbackId);
        if (node) children.push(node);
    }
    tree.bar.children = children;
    return tree;
}

/* ========================================================================== */
/*                                  导入                                       */
/* ========================================================================== */

/** 一次导入的去重统计 */
export interface MergeStats {
    added: number;
    skipped: number;
}

/**
 * 把导入的节点合并进现有文件夹。
 *
 * **按 URL 去重**（不是按 id）：导入的节点 id 来自 Edge，与本地 id 空间无关；
 * 而"同一个网址收藏两次"在界面上就是重复条目。
 *
 * 文件夹按**同名复用**（去首尾空格后标题相等）：命中已有的同名文件夹就递归并
 * 进去，不再另起一份拷贝。之前这里是"文件夹从不去重"，症状正是"重复导入一次，
 * 栏上多出一批空文件夹"—— 里面的网址全被判重跳过了，只剩空壳。
 * 同名判的是**标题文本**，不是身份：Edge 里允许同名文件夹（guid 不同），
 * 单次导入带来的同名文件夹照单全收（不破坏 Edge 原样结构），跨次重复导入才
 * 合并进第一个同名项。
 *
 * 两个计数器的口径都是**网址条数**（不含文件夹）：
 *   - `added`   真正新增的网址数；
 *   - `skipped` 因重复或 url 为空而丢弃的网址数。
 * 文件夹从不被"跳过"，所以不参与这套记账 —— 把它算进 added 会让
 * "导入了 3 条"与界面上的书签数对不上（文件夹不是书签）。
 *
 * 去重是**递归的**：导入的文件夹内部同样按 URL 过滤、同名子文件夹同样复用。
 * 只在顶层判重的症状是"重复导入一次，栏上是没多，点进文件夹发现里面翻倍了"。
 *
 * 返回新树与统计，不做原地修改。
 */
export function mergeIntoFolder(
    folder: BookmarkNode,
    incoming: BookmarkNode[],
    seenUrls: Set<string>,
    fallbackId: () => string
): { folder: BookmarkNode; stats: MergeStats } {
    const stats: MergeStats = { added: 0, skipped: 0 };

    /** 同名文件夹的下标（合并锚点）。空标题不参与匹配 —— 两个"未命名"并到一起是误伤 */
    const findSameName = (siblings: BookmarkNode[], title: string): number => {
        const key = (title || '').trim();
        if (!key) return -1;
        return siblings.findIndex(
            (c) => c.type === 'folder' && (c.title || '').trim() === key
        );
    };

    /** 整棵克隆并换新 id。只做 url 判重，不碰结构 —— 单次导入的原样要保住 */
    const cloneFresh = (node: BookmarkNode): BookmarkNode | null => {
        const id = fallbackId();
        if (node.type === 'url') {
            const url = (node.url || '').trim();
            if (!url || seenUrls.has(url)) { stats.skipped += 1; return null; }
            seenUrls.add(url);
            stats.added += 1;
            return { ...node, id };
        }
        const kids: BookmarkNode[] = [];
        for (const child of node.children || []) {
            const cloned = cloneFresh(child);
            if (cloned) kids.push(cloned);
        }
        // 文件夹本身永远保留，哪怕里面被去重掏空了 ——
        // 空文件夹是用户在 Edge 里的组织结构，不是冗余数据
        return { ...node, id, children: kids };
    };

    /** 把一批节点并进兄弟列表，返回新数组（输入不改） */
    const mergeList = (siblings: BookmarkNode[], nodes: BookmarkNode[]): BookmarkNode[] => {
        const next = [...siblings];
        for (const node of nodes) {
            if (!node) continue;
            if (node.type === 'url') {
                const cloned = cloneFresh(node);
                if (cloned) next.push(cloned);
                continue;
            }
            const at = findSameName(next, node.title || '');
            if (at >= 0) {
                const target = next[at];
                next[at] = { ...target, children: mergeList(target.children || [], node.children || []) };
                continue;
            }
            const cloned = cloneFresh(node);
            if (cloned) next.push(cloned);
        }
        return next;
    };

    return { folder: { ...folder, children: mergeList(folder.children || [], incoming) }, stats };
}

/** 收集一棵树里所有 url（供导入去重时预填 seen 集合） */
export function collectUrls(tree: BookmarkTree): Set<string> {
    const set = new Set<string>();
    for (const root of [tree.bar, tree.other]) {
        for (const entry of flattenUrls(root)) {
            const url = (entry.node.url || '').trim();
            if (url) set.add(url);
        }
    }
    return set;
}
