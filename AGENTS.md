# Kura の作業指示

作業を始める前に、リポジトリルートの `CLAUDE.md` を読み、プロジェクトのルールに従う。

スキルの正本は `.claude/skills/`。`.agents/skills/` は Codex が検出するためのリンクで、手順とスクリプトを共有する。スクリプトはリポジトリルートから、`CLAUDE.md` に書かれた `.claude/skills/` のパスで実行する。

`.claude/settings.json` の権限設定は Codex には適用されない。本物の資料フォルダ（`~/Pictures/References/` を含む）には、読み取りも含めて触れず、生成したダミーライブラリだけを使う。
