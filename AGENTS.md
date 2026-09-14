# montash の作業ルール

- ロードマップに沿って実装し、変更をレビューできる単位でブランチ・コミット・PRにまとめる。
- PRをセルフレビューし、指摘を修正して必要なテストとGitHub CIが通ったらマージして次の作業を進める。
- コミットメッセージには以下の両方のトレーラーを付ける。squash mergeの最終コミットメッセージにも残す。

```
Co-authored-by: Codex <noreply@openai.com>
Co-authored-by: Claude Code <noreply@anthropic.com>
```
