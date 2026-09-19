import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { JsoncCodeViewer } from './JsoncCodeViewer';
import type { CodeMirrorJsoncEditorHandle } from './CodeMirrorJsoncEditor';
import type { ProfileSourceDiagnostic } from './profileSourceDiagnostics';
import { deleteProfileDraft, loadProfileDraft, saveProfileDraft, sourceFingerprint } from './profileDrafts';

const CodeMirrorJsoncEditor = lazy(async () => {
  const module = await import('./CodeMirrorJsoncEditor');
  return { default: module.CodeMirrorJsoncEditor };
});

export type ReferencePage = 'source' | 'guide';
export type ProfileSourceSaveResult = { ok: true; id: string; raw: string } | { ok: false; error: string; offset?: number };
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
    readOnly: 'Read-only', edit: 'Edit JSONC', save: 'Save', cancel: 'Cancel', duplicate: 'Duplicate to edit', saved: 'Saved', discard: 'Discard unsaved JSONC changes?', location: 'Line {line}, column {column}', snippet: 'Example', path: 'Setting', search: 'Find in JSONC', previous: 'Previous match', next: 'Next match', noMatches: 'No matches', matchCount: '{current} of {total}', wrap: 'Wrap lines', sections: 'Sections', overview: 'Top', lines: '{count} lines', copyFailed: 'Unable to copy. Select the text and copy it manually.', format: 'Format', errors: '{count} errors', warnings: '{count} warnings', draftRestored: 'Unsaved draft restored', validating: 'Validating…', draftChanged: 'The saved Profile changed after this draft was created.', restoreDraft: 'Restore draft', discardDraft: 'Discard draft',
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
    readOnly: '唯讀', edit: '編輯 JSONC', save: '儲存', cancel: '取消', duplicate: '複製後編輯', saved: '已儲存', discard: '放棄尚未儲存的 JSONC 修改？', location: '第 {line} 行、第 {column} 欄', snippet: '範例', path: '設定位置', search: '搜尋 JSONC', previous: '上一個結果', next: '下一個結果', noMatches: '找不到結果', matchCount: '第 {current} / {total} 筆', wrap: '自動換行', sections: '設定區段', overview: '檔案開頭', lines: '共 {count} 行', copyFailed: '無法複製，請選取文字後手動複製。', format: '格式化', errors: '{count} 個錯誤', warnings: '{count} 個警告', draftRestored: '已復原未儲存草稿', validating: '正在檢查…', draftChanged: '建立草稿後，已儲存的設定檔曾被修改。', restoreDraft: '復原草稿', discardDraft: '捨棄草稿',
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
    readOnly: '読み取り専用', edit: 'JSONC を編集', save: '保存', cancel: 'キャンセル', duplicate: '複製して編集', saved: '保存しました', discard: '未保存の JSONC 変更を破棄しますか？', location: '{line} 行 {column} 列', snippet: '例', path: '設定箇所', search: 'JSONC を検索', previous: '前の一致', next: '次の一致', noMatches: '一致なし', matchCount: '{current} / {total} 件', wrap: '行を折り返す', sections: '設定セクション', overview: '先頭', lines: '{count} 行', copyFailed: 'コピーできません。テキストを選択して手動でコピーしてください。', format: '整形', errors: 'エラー {count} 件', warnings: '警告 {count} 件', draftRestored: '未保存の下書きを復元しました', validating: '検証中…', draftChanged: '下書きの作成後に保存済みプロファイルが変更されました。', restoreDraft: '下書きを復元', discardDraft: '下書きを破棄',
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
    readOnly: '읽기 전용', edit: 'JSONC 편집', save: '저장', cancel: '취소', duplicate: '복제 후 편집', saved: '저장됨', discard: '저장하지 않은 JSONC 변경 사항을 버릴까요?', location: '{line}행 {column}열', snippet: '예시', path: '설정 위치', search: 'JSONC 검색', previous: '이전 결과', next: '다음 결과', noMatches: '결과 없음', matchCount: '{current} / {total}', wrap: '줄 바꿈', sections: '설정 섹션', overview: '파일 시작', lines: '총 {count}줄', copyFailed: '복사할 수 없습니다. 텍스트를 선택해 직접 복사하세요.', format: '서식 지정', errors: '오류 {count}개', warnings: '경고 {count}개', draftRestored: '저장하지 않은 초안을 복원했습니다', validating: '검사 중…', draftChanged: '초안을 만든 뒤 저장된 프로필이 변경되었습니다.', restoreDraft: '초안 복원', discardDraft: '초안 삭제',
    topics: {
      request: ['메시지 보내기', '요청 주소, 메서드, 헤더와 본문을 설정합니다.'],
      timeout: ['시간 초과 설정', '전체 요청 시간과 스트림 이벤트가 없는 시간을 각각 제한합니다. 단위는 밀리초입니다.'],
      controls: ['컨트롤 추가', '채팅 위에 선택 항목을 표시합니다. 선택값은 controls.user로 참조합니다.'],
      opening: ['시작 메시지 설정', '대화가 시작될 때 고정된 인사말을 표시합니다.'],
      stream: ['스트림 이벤트 처리', '서버 이벤트를 텍스트 업데이트와 완료 상태에 연결합니다.'],
      tests: ['테스트 사례 추가', '입력을 보내고 결과를 확인합니다. 테스트 탭에서 실행합니다.'],
    },
  },
} satisfies Record<Locale, { source: string; guide: string; close: string; download: string; copy: string; copied: string; readOnly: string; edit: string; save: string; cancel: string; duplicate: string; saved: string; discard: string; location: string; snippet: string; path: string; search: string; previous: string; next: string; noMatches: string; matchCount: string; wrap: string; sections: string; overview: string; lines: string; copyFailed: string; format: string; errors: string; warnings: string; draftRestored: string; validating: string; draftChanged: string; restoreDraft: string; discardDraft: string; topics: Record<typeof topics[number]['id'], readonly [string, string]> }>;

export function ProfileReferencePanel({ page, onClose, profileId, profileName, raw, locale, readOnly = true, onSave, onDuplicate, onDownload, onCopy, onValidate }: {
  page: ReferencePage;
  onClose: () => void;
  profileId?: string;
  profileName: string;
  raw: string;
  locale: string;
  readOnly?: boolean;
  onSave?: (raw: string) => ProfileSourceSaveResult;
  onDuplicate?: () => { id: string; raw: string };
  onDownload: (value: string) => void;
  onCopy: (value: string) => Promise<void>;
  onValidate?: (value: string) => ProfileSourceDiagnostic[];
}): React.JSX.Element {
  const labels = translations[(locale in translations ? locale : 'en') as Locale];
  const [selected, setSelected] = useState<typeof topics[number]['id']>('request');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [editing, setEditing] = useState(page === 'source' && !readOnly && Boolean(onSave));
  const storedDraft = !readOnly && profileId ? loadProfileDraft(profileId) : undefined;
  const hasDraftConflict = Boolean(storedDraft && storedDraft.baseFingerprint !== sourceFingerprint(raw));
  const initialDraft = storedDraft && !hasDraftConflict ? storedDraft.draft : raw;
  const [pendingDraft, setPendingDraft] = useState(hasDraftConflict ? storedDraft : undefined);
  const [draft, setDraft] = useState(initialDraft);
  const [draftRestored] = useState(Boolean(storedDraft && !hasDraftConflict));
  const [diagnostics, setDiagnostics] = useState<ProfileSourceDiagnostic[]>(() => onValidate?.(initialDraft) ?? []);
  const [validating, setValidating] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const editor = useRef<CodeMirrorJsoncEditorHandle>(null);
  useEffect(() => { if (!editing) setDraft(raw); }, [raw, editing]);
  useEffect(() => { if (editing) editor.current?.focus(); }, [editing]);
  useEffect(() => {
    if (!editing || !onValidate) return;
    setValidating(true);
    const timer = window.setTimeout(() => { setDiagnostics(onValidate(draft)); setValidating(false); }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, editing, onValidate]);
  useEffect(() => {
    if (!editing || !profileId) return;
    if (draft === raw) { deleteProfileDraft(profileId); return; }
    const timer = window.setTimeout(() => saveProfileDraft(profileId, raw, draft), 500);
    return () => window.clearTimeout(timer);
  }, [draft, editing, profileId, raw]);
  const close = () => {
    if (editing && draft !== raw && !window.confirm(labels.discard)) return;
    onClose();
  };
  const cancel = () => {
    if (draft !== raw && !window.confirm(labels.discard)) return;
    onClose();
  };
  const save = () => {
    if (!onSave) return;
    const result = onSave(draft);
    if (!result.ok) {
      const before = draft.slice(0, result.offset ?? 0);
      const line = before.split('\n').length;
      const column = before.length - before.lastIndexOf('\n');
      setSaveError(`${labels.location.replace('{line}', String(line)).replace('{column}', String(column))}: ${result.error}`);
      if (result.offset !== undefined) {
        editor.current?.jumpToOffset(result.offset);
      }
      return;
    }
    setDraft(result.raw);
    setSaveError('');
    if (profileId) deleteProfileDraft(profileId);
    if (result.id !== profileId) deleteProfileDraft(result.id);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const background = document.getElementById('web-shell');
    if (background) background.inert = true;
    closeButton.current?.focus();
    return () => { if (background) background.inert = false; previous?.focus(); };
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (editing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });
  const copyValue = async (value: string) => {
    try { await onCopy(value); setCopyError(false); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch { setCopyError(true); setCopied(false); }
  };
  const topic = topics.find((item) => item.id === selected)!;
  return createPortal(<div className="profile-reference-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={panel} className="profile-reference-panel" role="dialog" aria-modal="true" aria-labelledby="profile-reference-title">
      <header className="profile-reference-header"><div><h2 id="profile-reference-title" title={page === 'source' ? profileName : labels.guide}>{page === 'source' ? profileName : labels.guide}</h2>{page === 'source' && <span>{editing ? labels.edit : `${labels.source}${readOnly ? ` · ${labels.readOnly}` : ''}`}</span>}</div><button ref={closeButton} type="button" onClick={close} aria-label={labels.close}>×</button></header>
      {page === 'source' ? <div id="profile-reference-source" className="profile-reference-content">
        <div className="profile-reference-toolbar"><span role="status">{copyError ? labels.copyFailed : copied ? labels.copied : saved ? labels.saved : draftRestored ? labels.draftRestored : validating ? labels.validating : ''}</span>{editing ? <><button type="button" onClick={() => editor.current?.format()}>{labels.format}</button><button type="button" onClick={() => void copyValue(draft)}>{labels.copy}</button><button type="button" onClick={() => onDownload(draft)}>{labels.download}</button><button type="button" onClick={cancel}>{labels.cancel}</button><button type="button" className="profile-reference-save" disabled={draft === raw || !onSave || diagnostics.some((item) => item.severity === 'error')} onClick={save}>{labels.save}</button></> : <>{readOnly && onDuplicate && <button type="button" onClick={() => { const copy = onDuplicate(); setDraft(copy.raw); setDiagnostics(onValidate?.(copy.raw) ?? []); setSaveError(''); setEditing(true); }}>{labels.duplicate}</button>}<button type="button" onClick={() => void copyValue(raw)}>{labels.copy}</button><button type="button" onClick={() => onDownload(raw)}>{labels.download}</button></>}</div>
        {editing ? <div className="profile-reference-editor">{pendingDraft && <div className="profile-reference-draft-conflict" role="status"><span>{labels.draftChanged}</span><button type="button" onClick={() => { setDraft(pendingDraft.draft); setPendingDraft(undefined); }}>{labels.restoreDraft}</button><button type="button" onClick={() => { if (profileId) deleteProfileDraft(profileId); setPendingDraft(undefined); }}>{labels.discardDraft}</button></div>}{saveError && <p role="alert" className="profile-reference-editor-error">{saveError}</p>}<Suspense fallback={<div className="profile-reference-editor-loading">{labels.validating}</div>}><CodeMirrorJsoncEditor ref={editor} value={draft} diagnostics={diagnostics} labels={labels} onChange={(value) => { setDraft(value); setSaveError(''); }} /></Suspense>{diagnostics.length > 0 && <div className="profile-reference-problems"><div><span className="problem-error">{labels.errors.replace('{count}', String(diagnostics.filter((item) => item.severity === 'error').length))}</span><span>{labels.warnings.replace('{count}', String(diagnostics.filter((item) => item.severity === 'warning').length))}</span></div><ul>{diagnostics.map((item, index) => <li key={`${item.code}-${item.offset}-${index}`}><button type="button" onClick={() => editor.current?.jumpToOffset(item.offset)}><span className={`problem-${item.severity}`} aria-hidden="true">{item.severity === 'error' ? '×' : '!'}</span>{item.message}</button></li>)}</ul></div>}</div> : <JsoncCodeViewer raw={raw} labels={labels} />}
      </div> : <div id="profile-reference-guide" className="profile-reference-guide">
        <nav aria-label={labels.guide}>{topics.map((item) => <button type="button" key={item.id} aria-current={selected === item.id ? 'page' : undefined} onClick={() => { setSelected(item.id); setCopied(false); }}>{labels.topics[item.id][0]}</button>)}</nav>
        <article><h3>{labels.topics[selected][0]}</h3><p>{labels.topics[selected][1]}</p><dl><dt>{labels.path}</dt><dd><code>{topic.path}</code></dd></dl><div className="profile-reference-toolbar"><span>{labels.snippet}</span><button type="button" onClick={() => void copyValue(topic.snippet)}>{copied ? labels.copied : labels.copy}</button></div><pre className="profile-reference-code"><code>{topic.snippet}</code></pre></article>
      </div>}
    </section>
  </div>, document.body);
}
