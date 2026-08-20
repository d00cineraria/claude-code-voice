#!/usr/bin/env node
// claude-code-voice: Claude Code の応答・通知を音声で読み上げる hook スクリプト
//
// Claude Code の hooks(Stop / Notification)から呼ばれ、stdin で受け取るイベントJSONを解釈して
// OS標準のTTSで読み上げる。外部依存ゼロ・ネットワーク不要・即応答。
// エンジン: macOS=say / Windows=System.Speech(β・実機未検証) / Linux=espeak-ng(β・実機未検証)
//
// - Stop:         応答の最後のテキストから要点(冒頭の数文)を抽出して読む
// - Notification: 許可待ち・入力待ちなどの通知を日本語にして読む
//
// 設定(環境変数、すべて省略可):
//   CLAUDE_VOICE        読み上げの声(デフォルト: Kyoko)
//   CLAUDE_VOICE_RATE   話速 wpm(デフォルト: 230。Kyokoの標準は約180)
//   CLAUDE_VOICE_MAX    読み上げる最大文字数(デフォルト: 120。0 で全文読み上げ)
//   CLAUDE_VOICE_DRYRUN 1 で読み上げず内容をstderrに出す(動作確認用)
//
// hook は応答をブロックしないよう即座に exit 0 する(sayは切り離して起動)

import { readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 読み上げエンジンはOSで自動判定: macOS=say / Windows=System.Speech(β) / Linux=espeak-ng(β)
const OS = process.platform;
const VOICE = process.env.CLAUDE_VOICE ?? (OS === 'darwin' ? 'Kyoko' : '');
const RATE = process.env.CLAUDE_VOICE_RATE ?? '230';
const MAX_CHARS = Number(process.env.CLAUDE_VOICE_MAX ?? '120');
const DRY_RUN = process.env.CLAUDE_VOICE_DRYRUN === '1';
// Windowsは読み上げプロセスのPIDをファイルで管理する(停止・実行中判定に使う)
const PID_FILE = join(tmpdir(), 'claude-code-voice.pid');

// ---- 読み上げエンジン(OS別) ---------------------------------------------------

// いま読み上げ中か(待機通知のスキップ判定に使う)
const isSpeaking = () => {
  if (OS === 'darwin') return spawnSync('pgrep', ['-x', 'say'], { stdio: 'ignore' }).status === 0;
  if (OS === 'linux') return spawnSync('pgrep', ['-x', 'espeak-ng'], { stdio: 'ignore' }).status === 0;
  if (OS === 'win32') {
    try {
      const pid = readFileSync(PID_FILE, 'utf8').trim();
      if (!pid) return false;
      const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf8' });
      return (out.stdout ?? '').includes(pid);
    } catch {
      return false;
    }
  }
  return false;
};

// 前の読み上げを止める(連続応答で声が重なるのを防ぐ)
const stopPrevious = () => {
  if (OS === 'darwin') spawnSync('pkill', ['-x', 'say'], { stdio: 'ignore' });
  else if (OS === 'linux') spawnSync('pkill', ['-x', 'espeak-ng'], { stdio: 'ignore' });
  else if (OS === 'win32') {
    try {
      const pid = readFileSync(PID_FILE, 'utf8').trim();
      if (pid) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* 前回分がなければ何もしない */
    }
  }
};

// hookを待たせないよう、読み上げは切り離して起動して即returnする
const startSpeaking = (text) => {
  if (OS === 'darwin') {
    spawn('say', ['-v', VOICE, '-r', RATE, text], { detached: true, stdio: 'ignore' }).unref();
  } else if (OS === 'linux') {
    // espeak-ng の -s は say と同じwpm指定(β: 実機未検証。要フィードバック)
    spawn('espeak-ng', ['-v', 'ja', '-s', RATE, text], { detached: true, stdio: 'ignore' }).unref();
  } else if (OS === 'win32') {
    // Windows標準の System.Speech で読み上げ(β: 実機未検証。要フィードバック)
    // テキストはstdin渡しにしてクォート問題を避ける。RateはSAPIの-10〜10へ換算(wpm基準)
    const sapiRate = Math.max(-10, Math.min(10, Math.round((Number(RATE) - 200) / 30)));
    const ps = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      `$s.Rate = ${sapiRate};`,
      VOICE ? `try { $s.SelectVoice('${VOICE.replace(/'/g, "''")}') } catch {};` : '',
      '$s.Speak([Console]::In.ReadToEnd());',
    ].join(' ');
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    try {
      writeFileSync(PID_FILE, String(child.pid ?? ''));
    } catch {
      /* PIDが取れなくても読み上げ自体は続行 */
    }
    child.stdin.end(text);
    child.unref();
  }
};

// ---- stdin のイベントJSONを読む -------------------------------------------------
const input = readFileSync(0, 'utf8');
let event;
try {
  event = JSON.parse(input);
} catch {
  process.exit(0); // 解釈できない入力は黙って無視(hookはClaude Codeの動作を妨げない)
}

// ---- 読み上げテキストの組み立て -------------------------------------------------

// Markdownの記号や整形要素を落として「耳で聞ける文章」にする
const toSpeakable = (text) =>
  text
    .replace(/```[\s\S]*?```/g, '。コード。') // コードブロックは読まない
    .replace(/^\s*\|.*$/gm, '') // 表の行は読まない(記号を抜くと単語の羅列になり意味不明のため)
    .replace(/`([^`]*)`/g, '$1') // インラインコードは中身(ファイル名など)を残して記号だけ除去
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // リンクは表示文字だけ
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b[0-9a-f]{7,40}\b/g, '') // コミットハッシュ等の16進IDは読まない
    .replace(/[((]\s*[、,]*\s*[))]/g, '') // 中身が消えて空になったかっこを除去
    .replace(/^[#>\-*|]+\s*/gm, '') // 見出し・引用・箇条書き・表の記号
    .replace(/[*~#|]/g, '') // 強調・見出し記号(_はファイル名に使われるため残す)
    .replace(/\s+/g, ' ')
    .trim();

// 文単位で先頭から拾い、最大文字数に収める(max=0 は全文)
const firstSentences = (text, max) => {
  if (max <= 0) return text;
  const sentences = text.split(/(?<=[。!?！？])/);
  let out = '';
  for (const s of sentences) {
    if (out && out.length + s.length > max) break;
    out += s;
    if (out.length >= max) break;
  }
  return (out || text).slice(0, max);
};

// transcript(JSONL)から最後のアシスタント発話テキストを取り出す
const lastAssistantText = (transcriptPath) => {
  const lines = readFileSync(transcriptPath, 'utf8').split('\n');
  let last = '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const texts = content.filter((c) => c.type === 'text' && c.text?.trim());
    if (texts.length > 0) last = texts[texts.length - 1].text;
  }
  return last;
};

let speech = '';

if (event.hook_event_name === 'Stop') {
  try {
    const raw = lastAssistantText(event.transcript_path);
    if (raw) {
      // 同じ応答は二度読まない。セッション再開時は前セッションの履歴が新しいログに
      // 引き継がれるため、放っておくと前回の最後のまとめをもう一度読んでしまう。
      // 記録は直近50件の履歴で持つ(複数セッション並行時に「最後の1件」だと
      // 互いに上書きし合って再読み上げ防止が破れるため)
      const histFile = join(tmpdir(), 'claude-code-voice.history');
      const hash = createHash('sha256').update(raw).digest('hex');
      let hist = [];
      try {
        hist = readFileSync(histFile, 'utf8').split('\n').filter(Boolean);
      } catch {
        /* 初回は記録なし */
      }
      if (hist.includes(hash)) process.exit(0);
      hist.push(hash);
      writeFileSync(histFile, `${hist.slice(-50).join('\n')}\n`);
      speech = firstSentences(toSpeakable(raw), MAX_CHARS);
    } else {
      speech = '応答が完了しました';
    }
  } catch {
    speech = '応答が完了しました';
  }
} else if (event.hook_event_name === 'Notification') {
  const msg = event.message ?? '';
  if (/permission|approval|承認|許可/i.test(msg)) {
    speech = 'クロードが許可を待っています';
  } else if (/waiting for (your )?input|idle|入力/i.test(msg)) {
    // 応答の読み上げ中に届く待機通知は無視する(読み上げを遮ってまで知らせる価値がない。
    // 許可待ちは操作が必要なので従来どおり割り込む)
    if (isSpeaking()) process.exit(0);
    speech = 'クロードが入力を待っています';
  } else if (/[^\x00-\x7F]/.test(msg)) {
    speech = msg; // 日本語の通知はそのまま読む
  } else {
    speech = 'クロードから通知があります';
  }
}

if (!speech) process.exit(0);

// 何をいつ読んだかの記録(不具合調査用。直近200行だけ保持)
try {
  const logFile = join(tmpdir(), 'claude-code-voice.log');
  let lines = [];
  try {
    lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  } catch {
    /* 初回 */
  }
  lines.push(
    `${new Date().toISOString()} ${event.hook_event_name} ${event.session_id ?? '-'} len=${speech.length}${isSpeaking() ? ' [前の読み上げを中断]' : ''} :: ${speech.slice(0, 120)}`,
  );
  writeFileSync(logFile, `${lines.slice(-200).join('\n')}\n`);
} catch {
  /* ログ失敗は無視 */
}

// ---- 読み上げ ------------------------------------------------------------------

if (DRY_RUN) {
  console.error(`[claude-code-voice] ${VOICE}@${RATE}wpm: ${speech}`);
  process.exit(0);
}

stopPrevious();
startSpeaking(speech);

process.exit(0);
