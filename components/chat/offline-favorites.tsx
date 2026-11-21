"use client";

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { kvGet, kvSetAsync, registerDynamicPrefix } from "@/lib/kv-db";

const PREFIX = "ai_phone_offline_favorites:";
registerDynamicPrefix(PREFIX);
type Favorite = { id: string; text: string; at: string };
const Shelf = createContext<{ rows: Favorite[]; busy: boolean; change: (item: Favorite) => Promise<void> } | null>(null);

function load(key: string): Favorite[] {
    try {
        const rows: unknown = JSON.parse(kvGet(key) || "[]");
        return Array.isArray(rows) ? rows.filter((r): r is Favorite => r && typeof r.id === "string" && typeof r.text === "string" && typeof r.at === "string") : [];
    } catch { return []; }
}

export function OfflineFavorites({ sessionId, children, onNotice }: { sessionId: string; children: ReactNode; onNotice: (text: string) => void }) {
    const key = PREFIX + sessionId;
    const [rows, setRows] = useState(() => load(key));
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState(false);
    const writing = useRef(false);
    const change = async (item: Favorite) => {
        if (writing.current) return;
        const exists = rows.some(row => row.id === item.id);
        if (!exists && (!item.text.trim() || rows.length >= 500)) {
            onNotice(item.text.trim() ? "已收藏 500 条，请先移除不需要的内容" : "没有可收藏的正文");
            return;
        }
        const next = exists ? rows.filter(row => row.id !== item.id) : [item, ...rows];
        writing.current = true;
        setBusy(true);
        try {
            await kvSetAsync(key, JSON.stringify(next));
            setRows(next);
            onNotice(exists ? "已取消收藏" : "已保存正文，可到「线下收藏」查看");
        } catch {
            onNotice("未能确认写入本地存储，请重试");
        } finally { writing.current = false; setBusy(false); }
    };
    return <Shelf.Provider value={{ rows, busy, change }}>
        <div className="chat-offline-body">
            <div>
                <button type="button" className="ui-btn ui-btn-outline" aria-expanded={open} onClick={() => setOpen(value => !value)}>线下收藏（{rows.length}）</button>
                {open && <section aria-label="线下收藏" style={{ padding: 12 }}>
                    <input type="search" aria-label="搜索线下收藏" placeholder="搜索讲解关键词" value={query} onChange={e => setQuery(e.target.value)} />
                    {rows.filter(row => row.text.toLowerCase().includes(query.trim().toLowerCase())).map(row => <details key={row.id} style={{ marginTop: 10 }}>
                        <summary>{row.text.replace(/\s+/g, " ").slice(0, 54)}{row.text.length > 54 ? "…" : ""}</summary>
                        <small>{new Date(row.at).toLocaleString()}</small>
                        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text" }}>{row.text}</div>
                        <button type="button" className="ui-btn ui-btn-outline" disabled={busy} onClick={() => void change(row)}>取消收藏</button>
                    </details>)}
                    {!rows.length && <p>还没有收藏。长按线下消息，再点「收藏」即可保存正文。</p>}
                    {rows.length > 0 && !rows.some(row => row.text.toLowerCase().includes(query.trim().toLowerCase())) && <p>没有匹配的收藏。</p>}
                </section>}
            </div>
            {children}
        </div>
    </Shelf.Provider>;
}

export function OfflineFavoriteMenuItem({ id, text, at }: Favorite) {
    const shelf = useContext(Shelf);
    if (!shelf || !text.trim()) return null;
    const saved = shelf.rows.some(row => row.id === id);
    return <button type="button" className="ctx-menu-btn" disabled={shelf.busy} onClick={() => void shelf.change({ id, text, at })}>
        {saved ? "取消收藏" : "收藏"}
    </button>;
}
