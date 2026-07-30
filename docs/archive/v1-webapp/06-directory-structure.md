# 6. ディレクトリ構成

pnpm workspaces + Turborepo によるモノレポ構成。理由は [07-tech-stack.md](./07-tech-stack.md) を参照。Phase2でクライアント向けの別UI（閲覧専用ポータル等）が必要になっても `apps/` に追加するだけで対応でき、DB・AI・連携ロジックは共通利用できる。

```
workaholic-content-os/
├── apps/
│   └── web/                          # Next.js 本体（管理画面）
│       ├── app/
│       │   ├── (auth)/
│       │   │   ├── login/
│       │   │   └── onboarding/
│       │   ├── (dashboard)/
│       │   │   ├── layout.tsx        # サイドバー等の共通レイアウト
│       │   │   ├── dashboard/
│       │   │   │   └── page.tsx
│       │   │   ├── content/
│       │   │   │   ├── page.tsx      # カンバン/リスト/カレンダー
│       │   │   │   └── [videoId]/
│       │   │   │       ├── page.tsx
│       │   │   │       └── (tabs: plan / script / titles / thumbnails /
│       │   │   │            description / shorts / edit-instruction /
│       │   │   │            posts / analytics)
│       │   │   ├── ideas/
│       │   │   │   └── page.tsx
│       │   │   ├── calendar/
│       │   │   │   └── page.tsx
│       │   │   ├── kpi/
│       │   │   │   └── page.tsx
│       │   │   ├── reports/
│       │   │   │   ├── page.tsx
│       │   │   │   └── [period]/page.tsx
│       │   │   └── settings/
│       │   │       ├── workspace/
│       │   │       ├── channels/
│       │   │       ├── members/
│       │   │       └── ai/
│       │   └── api/
│       │       ├── trpc/[trpc]/route.ts
│       │       └── webhooks/
│       │           ├── youtube/route.ts
│       │           └── inngest/route.ts
│       ├── components/
│       │   ├── ui/                   # shadcn 由来の基礎コンポーネント
│       │   ├── kanban/
│       │   ├── charts/
│       │   └── video-detail/
│       ├── lib/
│       │   ├── trpc/
│       │   └── auth/
│       └── styles/
│
├── packages/
│   ├── db/                           # Prisma schema + generated client
│   │   ├── schema.prisma
│   │   └── seed.ts
│   ├── ai/                           # Claude連携・プロンプトテンプレート
│   │   ├── client.ts                 # Anthropic SDK ラッパー
│   │   ├── prompts/
│   │   │   ├── idea-generation.ts
│   │   │   ├── title-options.ts
│   │   │   ├── thumbnail-concepts.ts
│   │   │   ├── script.ts
│   │   │   ├── edit-instruction.ts
│   │   │   ├── shorts-clips.ts
│   │   │   ├── caption-hashtag.ts
│   │   │   ├── kpi-analysis.ts
│   │   │   └── monthly-report.ts
│   │   └── types.ts
│   ├── integrations/                 # 外部プラットフォームAPIクライアント
│   │   ├── youtube/
│   │   ├── instagram/
│   │   ├── tiktok/
│   │   └── platform-client.ts        # 共通インターフェース定義
│   ├── jobs/                         # Inngest ジョブ定義
│   │   ├── sync-kpi-daily.ts
│   │   ├── generate-ideas-weekly.ts
│   │   └── generate-report-monthly.ts
│   └── ui/                           # 共有デザインシステム（トークン・アイコン等）
│
├── docs/                             # 本設計ドキュメント一式
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

## 6.1 設計意図

- `packages/ai` を独立パッケージにすることで、**プロンプトのバージョン管理・改善がコードレビューの対象として明確になる**。ここがこの事業の差別化資産になるため、UIコードと混ぜない。
- `packages/integrations` はプラットフォームAPIの仕様変更（YouTube/Instagram/TikTokは頻繁に変わる）の影響範囲を局所化する。
- `apps/web` 配下は Next.js の規約に従うだけで、Route Groups（`(dashboard)`）でレイアウトを分離し、動画詳細ページのタブは並列ルートまたはクライアントサイドのタブコンポーネントで実装する。
