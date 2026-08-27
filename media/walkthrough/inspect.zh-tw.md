## 從左到右閱讀一次執行結果

手機預覽呈現聊天使用者會看到的結果；Debug 則說明結果如何產生：

| 檢視 | 驗證內容 |
| --- | --- |
| Request | 已解析且遮蔽敏感值的請求 |
| Raw Events | 傳輸順序、時間與原始 payload |
| Normalized | Mapping 規則產生的事件 |
| Metrics | 延遲、資料量與 mapping 計數 |
| Errors | 傳輸、解析、mapping 與 runtime 錯誤 |
| Runs | 保存的證據與可重現 replay |

選取聊天訊息可定位來源事件；選取事件也能找出它變更的訊息。
