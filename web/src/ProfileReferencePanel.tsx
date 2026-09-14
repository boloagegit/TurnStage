import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { JsoncCodeViewer } from './JsoncCodeViewer';

export type ReferencePage = 'source' | 'guide';
type Locale = 'en' | 'zh-TW' | 'ja' | 'ko';

const topics = [
  { id: 'request', path: 'conversation.send', snippet: '"conversation": {\n  "send": {\n    "method": "POST",\n    "url": "${env.baseUrl}/chat",\n    "headers": { "Content-Type": "application/json" },\n    "variants": [{ "id": "default", "body": { "message": { "$value": "input.text" } } }]\n  }\n}' },
  { id: 'timeout', path: 'conversation.send', snippet: '"timeoutMs": 120000,\n"idleTimeoutMs": 30000' },
  { id: 'controls', path: 'controls', snippet: '"controls": [{\n  "id": "user", "type": "select", "label": "User",\n  "default": "a",\n  "options": [{ "label": "User A", "value": "a" }]\n}]' },
  { id: 'opening', path: 'opening', snippet: '"opening": {\n  "mode": "static",\n  "message": "Welcome. How can I help?"\n}' },
  { id: 'stream', path: 'stream', snippet: '"stream": {\n  "transport": "sse", "dataFormat": "json",\n  "mappings": [\n    { "id": "message", "match": { "event": "message" },\n      "emit": { "type": "content.text.delta", "text": { "path": "$.text" } } },\n    { "id": "done", "match": { "event": "done" },\n      "emit": { "type": "stream.completed" } }\n  ]\n}' },
  { id: 'tests', path: 'tests.scenarios', snippet: '"tests": {\n  "scenarios": [{\n    "id": "smoke", "name": "Smoke test",\n    "steps": [{ "id": "first", "input": "Hello",\n      "assertions": [{ "path": "turn.state", "operator": "equals", "value": "completed" }] }]\n  }]\n}' },
] as const;

const translations = {
  en: {
    source: 'View JSONC', guide: 'Profile guide', close: 'Close', download: 'Download JSONC', copy: 'Copy', copied: 'Copied',
    readOnly: 'Read-only', snippet: 'Example', path: 'Setting', search: 'Find in JSONC', previous: 'Previous match', next: 'Next match', noMatches: 'No matches', matchCount: '{current} of {total}', wrap: 'Wrap lines', sections: 'Sections', overview: 'Top', lines: '{count} lines', copyFailed: 'Unable to copy. Select the text and copy it manually.',
    topics: {
      request: ['Send a message', 'Set the endpoint, method, headers, and message body.'],
      timeout: ['Set timeouts', 'Request timeout limits the whole request. Idle timeout limits time without a stream event. Values are milliseconds.'],
      controls: ['Add a control', 'Show a choice above the chat. Use controls.user in a request body to send its selected value.'],
      opening: ['Set an opening message', 'Show a fixed greeting when the conversation starts.'],
      stream: ['Read stream events', 'Map server events to text updates and completion. Match event names to your server.'],
      tests: ['Add a test case', 'Send an input and check a result. Run it from the Tests tab.'],
    },
  },
  'zh-TW': {
    source: '檢視 JSONC', guide: '設定檔指南', close: '關閉', download: '下載 JSONC', copy: '複製', copied: '已複製',
    readOnly: '唯讀', snippet: '範例', path: '設定位置', search: '搜尋 JSONC', previous: '上一個結果', next: '下一個結果', noMatches: '找不到結果', matchCount: '第 {current} / {total} 筆', wrap: '自動換行', sections: '設定區段', overview: '檔案開頭', lines: '共 {count} 行', copyFailed: '無法複製，請選取文字後手動複製。',
    topics: {
      request: ['傳送訊息', '設定請求網址、方法、標頭與訊息內容。'],
      timeout: ['設定逾時', '請求逾時限制整個請求；閒置逾時限制串流沒有新事件的時間。單位為毫秒。'],
      controls: ['新增控制項', '在對話上方提供選項。請求內容可用 controls.user 取得選取值。'],
      opening: ['設定開場白', '對話開始時顯示固定的問候語。'],
      stream: ['處理串流事件', '將伺服器事件對應到文字更新與完成狀態；事件名稱要與伺服器一致。'],
      tests: ['新增測試案例', '傳送輸入並檢查結果，再到「測試」頁執行。'],
    },
  },
  ja: {
    source: 'JSONC を表示', guide: 'プロファイルガイド', close: '閉じる', download: 'JSONC をダウンロード', copy: 'コピー', copied: 'コピーしました',
    readOnly: '読み取り専用', snippet: '例', path: '設定箇所', search: 'JSONC を検索', previous: '前の一致', next: '次の一致', noMatches: '一致なし', matchCount: '{current} / {total} 件', wrap: '行を折り返す', sections: '設定セクション', overview: '先頭', lines: '{count} 行', copyFailed: 'コピーできません。テキストを選択して手動でコピーしてください。',
    topics: {
      request: ['メッセージを送信', '送信先、メソッド、ヘッダー、本文を設定します。'],
      timeout: ['タイムアウトを設定', 'リクエスト全体と、ストリームイベントが届かない時間を別々に制限します。単位はミリ秒です。'],
      controls: ['コントロールを追加', 'チャット上部に選択肢を表示します。選択値は controls.user から参照できます。'],
      opening: ['開始メッセージを設定', '会話の開始時に固定の挨拶を表示します。'],
      stream: ['ストリームイベントを処理', 'サーバーイベントをテキスト更新と完了状態に対応付けます。'],
      tests: ['テストケースを追加', '入力を送信して結果を確認します。「テスト」タブから実行します。'],
    },
  },
  ko: {
    source: 'JSONC 보기', guide: '프로필 가이드', close: '닫기', download: 'JSONC 다운로드', copy: '복사', copied: '복사됨',
    readOnly: '읽기 전용', snippet: '예시', path: '설정 위치', search: 'JSONC 검색', previous: '이전 결과', next: '다음 결과', noMatches: '결과 없음', matchCount: '{current} / {total}', wrap: '줄 바꿈', sections: '설정 섹션', overview: '파일 시작', lines: '총 {count}줄', copyFailed: '복사할 수 없습니다. 텍스트를 선택해 직접 복사하세요.',
    topics: {
      request: ['메시지 보내기', '요청 주소, 메서드, 헤더와 본문을 설정합니다.'],
      timeout: ['시간 초과 설정', '전체 요청 시간과 스트림 이벤트가 없는 시간을 각각 제한합니다. 단위는 밀리초입니다.'],
      controls: ['컨트롤 추가', '채팅 위에 선택 항목을 표시합니다. 선택값은 controls.user로 참조합니다.'],
      opening: ['시작 메시지 설정', '대화가 시작될 때 고정된 인사말을 표시합니다.'],
      stream: ['스트림 이벤트 처리', '서버 이벤트를 텍스트 업데이트와 완료 상태에 연결합니다.'],
      tests: ['테스트 사례 추가', '입력을 보내고 결과를 확인합니다. 테스트 탭에서 실행합니다.'],
    },
  },
} satisfies Record<Locale, { source: string; guide: string; close: string; download: string; copy: string; copied: string; readOnly: string; snippet: string; path: string; search: string; previous: string; next: string; noMatches: string; matchCount: string; wrap: string; sections: string; overview: string; lines: string; copyFailed: string; topics: Record<typeof topics[number]['id'], readonly [string, string]> }>;

export function ProfileReferencePanel({ page, onClose, profileName, raw, locale, onDownload, onCopy }: {
  page: ReferencePage;
  onClose: () => void;
  profileName: string;
  raw: string;
  locale: string;
  onDownload: () => void;
  onCopy: (value: string) => Promise<void>;
}): React.JSX.Element {
  const labels = translations[(locale in translations ? locale : 'en') as Locale];
  const [selected, setSelected] = useState<typeof topics[number]['id']>('request');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const background = document.getElementById('web-shell');
    if (background) background.inert = true;
    closeButton.current?.focus();
    return () => { if (background) background.inert = false; previous?.focus(); };
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  const copyValue = async (value: string) => {
    try { await onCopy(value); setCopyError(false); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch { setCopyError(true); setCopied(false); }
  };
  const topic = topics.find((item) => item.id === selected)!;
  return createPortal(<div className="profile-reference-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} className="profile-reference-panel" role="dialog" aria-modal="true" aria-labelledby="profile-reference-title">
      <header className="profile-reference-header"><div><h2 id="profile-reference-title" title={page === 'source' ? profileName : labels.guide}>{page === 'source' ? profileName : labels.guide}</h2>{page === 'source' && <span>{labels.source} · {labels.readOnly}</span>}</div><button ref={closeButton} type="button" onClick={onClose} aria-label={labels.close}>×</button></header>
      {page === 'source' ? <div id="profile-reference-source" className="profile-reference-content">
        <div className="profile-reference-toolbar"><span role="status">{copyError ? labels.copyFailed : copied ? labels.copied : ''}</span><button type="button" onClick={() => void copyValue(raw)}>{labels.copy}</button><button type="button" onClick={onDownload}>{labels.download}</button></div>
        <JsoncCodeViewer raw={raw} labels={labels} />
      </div> : <div id="profile-reference-guide" className="profile-reference-guide">
        <nav aria-label={labels.guide}>{topics.map((item) => <button type="button" key={item.id} aria-current={selected === item.id ? 'page' : undefined} onClick={() => { setSelected(item.id); setCopied(false); }}>{labels.topics[item.id][0]}</button>)}</nav>
        <article><h3>{labels.topics[selected][0]}</h3><p>{labels.topics[selected][1]}</p><dl><dt>{labels.path}</dt><dd><code>{topic.path}</code></dd></dl><div className="profile-reference-toolbar"><span>{labels.snippet}</span><button type="button" onClick={() => void copyValue(topic.snippet)}>{copied ? labels.copied : labels.copy}</button></div><pre className="profile-reference-code"><code>{topic.snippet}</code></pre></article>
      </div>}
    </section>
  </div>, document.body);
}
