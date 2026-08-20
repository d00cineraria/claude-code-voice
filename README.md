# claude-code-voice

Claude Code に「声」をつける hook。応答が終わったら要点を読み上げ、許可待ち・入力待ちになったら声で知らせる。

*A Claude Code hook that speaks: reads responses aloud when Claude finishes, and calls out when it's waiting for your permission or input. Zero dependencies — uses the OS built-in TTS.*

## なぜ作ったか

Claude Code に作業を任せている間、人は別の作業をしている。問題は、**Claude が止まっていることに気づけない**こと。許可待ちのまま10分放置していた、応答が終わっていたのに画面を見ていなかった——この「待ち時間の空回り」をなくすために、画面を見なくても耳で分かるようにした。

## 何が起きるか

| Claude Code の状態 | 読み上げ |
|---|---|
| 応答が完了(Stop) | 応答の冒頭の数文を読む(Markdown記号・コード・URLは除去。全文モードあり) |
| ツール実行の許可待ち(Notification) | 「クロードが許可を待っています」 |
| 入力待ち(Notification) | 「クロードが入力を待っています」 |

- OS標準のTTSを使用。**外部依存ゼロ・ネットワーク不要・APIコストゼロ**
- hookは即座に exit するので Claude Code の動作を一切ブロックしない
- 連続応答では前の読み上げを止めてから次を読む(声が重ならない)。応答の読み上げ中に届く「入力待ち」通知は無視する(読み上げを遮らない)

## 対応OS

| OS | エンジン | 状態 |
|---|---|---|
| macOS | `say`(Kyoko) | **検証済み**。作者が常用 |
| Windows | PowerShell `System.Speech`(Haruka等) | **β・実機未検証**。動いた/動かなかったの報告を募集中 → Issueへ |
| Linux | `espeak-ng`(要インストール) | **β・実機未検証**。同上 |

OSは自動判定されるので設定は共通です。

## インストール

```bash
git clone https://github.com/d00cineraria/claude-code-voice.git
```

`~/.claude/settings.json` に hooks を追加(パスはcloneした場所に合わせる):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /path/to/claude-code-voice/speak.mjs" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "node /path/to/claude-code-voice/speak.mjs" }] }
    ]
  }
}
```

Claude Code を再起動(または新しいセッションを開始)すると有効になる。プロジェクト単位で使いたい場合は、そのプロジェクトの `.claude/settings.json` に同じ設定を書く。

## 設定(環境変数)

すべて省略可。hooks の `command` の先頭に付けて調整する(例: `CLAUDE_VOICE_MAX=0 CLAUDE_VOICE_RATE=345 node /path/to/speak.mjs`)。

| 変数 | デフォルト | 意味 |
|---|---|---|
| `CLAUDE_VOICE` | macOS: `Kyoko` / 他OS: システム既定 | 読み上げの声(macOSは `say -v '?'` で一覧) |
| `CLAUDE_VOICE_RATE` | `230` | 話速(wpm)。目安: 230=1.3倍速 / 345=1.5倍 / 460=2倍。WindowsではSAPIの段階に自動換算 |
| `CLAUDE_VOICE_MAX` | `120` | Stop時に読む最大文字数。`0` で全文読み上げ |
| `CLAUDE_VOICE_DRYRUN` | - | `1` で読み上げず内容をstderrに出す(動作確認用) |

## 動作確認

```bash
# 通知の読み上げ(実際に音が鳴る)
echo '{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}' \
  | node speak.mjs

# 何を読むかだけ確認(音なし)
echo '{"hook_event_name":"Notification","message":"Claude is waiting for your input"}' \
  | CLAUDE_VOICE_DRYRUN=1 node speak.mjs
```

## 仕組み

Claude Code の [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) は、イベント発生時に任意のコマンドを実行し、イベント情報をJSONでstdinに渡す。

- `Stop` イベントには会話ログ(transcript)のパスが入っているので、JSONLをパースして最後のアシスタント発話を取り出す
- コードブロックは「コード。」に置換、インラインコードは中身(ファイル名など)だけ残す、リンクは表示文字だけ残す——「耳で聞ける文章」に整えてから、文の区切りで最大文字数に収める
- 読み上げは detached で起動して即 exit 0。読み上げの長さが Claude Code の応答性に影響しない

## 使いながら直した穴(開発メモ)

実際に常用して見つかった問題と対処。同種のツールを作る人の参考に:

1. **インラインコードを丸ごと削除していた** → `` `weekly_report.mjs` `` のようなファイル名が文から消えて意味不明に。中身を残して記号だけ除去に変更
2. **アンダースコアをMarkdown強調として除去していた** → `weekly_report` が「weeklyreport」に。`_` は除去対象から除外
3. **待機通知が長文の読み上げを殺していた** → 応答完了の約1分後にClaude Codeが出す「入力待ち」通知が、読み上げ中の声を上書き。読み上げ中の待機通知は無視するよう変更(許可待ちは操作が必要なので割り込み続ける)
4. **セッション再開時に前回のまとめを再読み上げしていた** → 再開すると前セッションの履歴が新しいログに引き継がれるため、最後の応答がもう一度読まれる。読んだ本文のハッシュを記録し、同一内容はスキップするよう変更

## License

MIT
