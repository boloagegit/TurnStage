# TurnStage Web 使用手冊

本文件提供使用 TurnStage Web 的一般使用者操作說明。部署人員若要安裝 Web 檔案、設定公司官方 Profile 或調整 `turnstage-catalog.json`，請改看 [Web 部署手冊](web-deployment.md)。VS Code 擴充套件的操作方式不在本文件範圍內。

## 開始使用

1. 使用公司提供的 HTTPS 網址開啟 TurnStage Web。不要直接以 `file://` 開啟解壓縮後的 `index.html`。
2. 從左側清單選擇一個 Profile。
3. 確認左側的 Environment，以及畫面上方顯示的連線狀態。
4. 在聊天輸入框送出一筆不含敏感資料的測試訊息。
5. 從右側的「除錯」、「測試」或「紅隊測試」頁籤檢查請求、事件、結果與證據。

瀏覽器會直接連線到目標 API。公司 Linux Web Server 只提供靜態網頁，不會代替瀏覽器轉送 API 請求。

## 辨識 Profile 來源

左側每個 Profile 都會顯示來源：

- **官方範本**：由公司部署的 Catalog 提供，所有使用者會看到相同的目前版本，不能直接覆寫。
- **瀏覽器本機**：只存在目前瀏覽器與目前網站來源中，可自行編輯或刪除。
- **瀏覽器本機 · 源自官方範本**：由官方範本複製或修改而來。本機副本不會因官方範本更新而被覆蓋。

若官方範本在建立副本後升版，TurnStage Web 會在本機副本旁提示有新版。請自行比較並決定是否重新複製新版；系統不會自動合併或覆蓋本機內容。

## 建立與修改 Profile

### 使用官方範本

直接選擇官方範本即可執行測試。官方範本的設定控制會停用，畫面會提示先按「複製後編輯」或左側的「複製」。複製完成後才會切換到可編輯的瀏覽器本機副本；TurnStage Web 不會因為碰到欄位就暗中建立副本，官方範本仍保持不變。

### 新增空白 Profile

選擇左側標題旁的「新增設定檔」按鈕。新 Profile 會包含可通過基本驗證的請求與串流骨架，接著可在「設定」中修改名稱、Environment、Request 與事件 Mapping。

### 複製 Profile

選擇 Profile 後按「複製」。新副本會取得不重複的 ID，例如 `basic-sse-chat-copy` 或 `basic-sse-chat-copy-2`。

### 匯入 Profile

1. 按左側標題旁的「匯入設定檔」。
2. 優先選擇 TurnStage Web 產生的 `*.turnstage-profile.json` 可攜檔。它會一次匯入 Profile、對應 Environment，以及兩者內直接寫入的 token 等設定。
3. 若 Profile 或 Environment ID 已存在，TurnStage Web 會為兩者產生不重複的本機 ID，並同步修正 Profile 的 Environment 參照，不會覆蓋既有資料。
4. 舊版單一 `.json` 或 `.jsonc` Profile 仍可匯入，但不包含 Environment；使用前需確認目前瀏覽器已有相符 Environment。
5. 匯入後先檢查 Environment、目標 URL、headers、Request body 與事件 Mapping，再執行測試。

匯入檔案視為不受信任的設定。不要匯入來源不明的檔案；可攜檔可包含明文 token、cookie、password 或 API key，匯入前應確認分享者與目標網址。

### 匯出 Profile

選擇 Profile 後按「匯出可攜檔」。下載的 `*.turnstage-profile.json` 同時包含 Profile、它參照的 Environment，以及兩者內直接寫入的明文 token 等設定。頁面記憶體中的 `${secret.*}` 值不會匯出。收件人只需從「匯入設定檔」選擇這一個檔案。將檔案交給他人前，仍應人工檢查 URL、headers、credential、測試輸入與其他內部資訊。

### 刪除或重設

- 本機 Profile 可按「刪除」移除。
- 官方 Profile 不能刪除。
- 若本機 Profile 使用與官方項目相同的 ID，刪除本機項目後會重新顯示目前的官方版本。

刪除瀏覽器資料後沒有伺服器端回收站。重要 Profile 應先匯出備份。

## Environment 與 secrets

展開左側的「環境」區塊可以選擇、匯入、匯出或編輯 Environment。

- 修改官方 Environment 時，系統會建立瀏覽器本機副本。
- Profile 使用 `${env.name}` 讀取 Environment variable。
- Profile 或 Environment 可直接寫入共用的明文 token、cookie、password 或 API key；它們會保存於 `localStorage`，也會包含於可攜匯出檔。
- Profile 使用 `${secret.name}` 表示不需要分享、只由目前使用者輸入的 session secret。
- Environment 的 `secretReferences` 只描述 secret 名稱，不保存 secret 值。
- secret 值只保留在目前頁面的記憶體，重新整理或關閉頁面後必須重新輸入。

只有確定收件人都應取得同一份 credential 時，才把它直接寫入 Profile、Environment 或公司 Catalog。可攜檔與 Catalog 都不是加密的；任何能讀取檔案或網站靜態內容的人都能看到明文。測試案例、CSV、報告與截圖仍不應放入 credential。

## 測試、紅隊案例與執行記錄

TurnStage Web 可以在瀏覽器中使用功能測試、紅隊案例、Campaign、執行記錄、Evidence 與視覺 baseline。依畫面提供的按鈕匯入或匯出 JSON、JSONC、JSONL、CSV、HTML、JUnit 或 ZIP 檔案。

Web 的「匯入」會把測試套件複製到此網站的 IndexedDB；後續編輯只修改瀏覽器副本，不會修改電腦上的原始檔。原始檔若在外部更新，請重新匯入。需要持續連結 workspace 檔案、從磁碟重新整理或在編輯器開啟原始檔時，請使用 VSIX；這些按鈕在 Web 會明確停用，不會等到操作後才報錯。

只由 VS Code Extension Host 提供且沒有瀏覽器替代方案的控制會直接停用，例如連結 workspace 測試套件、開啟 VS Code Test Explorer、Output Channel，以及所有 GitHub Copilot／Profile Doctor／AI Advisory 操作。這類停用控制不是故障；請改用 Web 畫面內的匯入副本、測試、證據與確定性診斷功能，或在 VSIX 中執行該項操作。

執行前請確認：

- 目標系統允許此測試流量，且目前 Environment 指向正確的非正式環境。
- CSV／JSONC 中沒有正式客戶資料、credential 或不應外流的 prompt。
- timeout、連線失敗或證據不完整不代表測試通過。
- 匯出 Evidence 或報告後，仍依公司資料分類政策保存與分享。

## 瀏覽器資料與備份

TurnStage Web 的資料以網站來源（scheme、host、port）隔離：

- Profile、Environment 與顯示偏好保存在版本化 `localStorage`。
- 較大的測試套件、執行記錄、Evidence、Campaign 與視覺 baseline 保存在 IndexedDB。
- 官方 Catalog 不會寫入上述瀏覽器儲存空間。
- 直接寫入 Profile 或 Environment 的 credential 會存在 `localStorage`；`${secret.*}` 的 session 值只存在頁面記憶體。

改用另一個瀏覽器、無痕視窗、電腦、網域或連接埠時，不會自動看到原本資料。清除網站資料也會移除本機資料。變更網址或清除資料前，請先匯出需要保留的 Profile、Environment、測試案例與證據。

## 常見問題

### 顯示「使用內建官方範本」

部署端 Catalog 無法取得、格式不正確、超過容量限制、包含重複 ID，或 Profile 驗證失敗。使用者仍可使用內建範本；請將狀態訊息交給部署管理者檢查。

### 瀏覽器顯示 CORS 或 Failed to fetch

確認目標 API：

- 能從使用者電腦連線；
- 使用瀏覽器信任的 TLS 憑證；
- 允許 TurnStage Web 的完整 origin；
- 允許需要的 HTTP method 與 request headers。

TurnStage Web 不能停用瀏覽器的 TLS 驗證，也不能繞過 CORS。

### 重新整理後 session secret 消失

這是 `${secret.*}` 的預期行為。重新輸入後再執行測試。若公司決定共用固定 credential，可把明文值直接寫入 Profile 或 Environment，再透過可攜檔分享。

### 找不到之前的本機 Profile

確認是否使用相同的瀏覽器、一般／無痕模式、協定、網域與連接埠，並確認沒有清除網站資料。若部署網址已變更，只能從先前匯出的檔案重新匯入。

### Web 與 VSIX 是否共用資料

不會自動共用。Web 使用瀏覽器儲存空間；VSIX 使用 VS Code workspace、檔案系統與 SecretStorage。Web 使用者之間應用可攜 Profile 檔搬移 Profile 與 Environment。VSIX 可繼續匯入舊版單一 Profile JSONC，但不會把 Web 可攜檔當成一般 Profile。

## 使用完成前檢查

1. 確認 Profile 或 Environment 內的明文 credential 只會分享給有權使用的人，且案例與報告沒有正式資料。
2. 匯出需要保留或交接的本機資料。
3. 對外分享匯出檔案前重新檢查內容。
4. 共用電腦使用完畢後，依公司政策清除網站資料；清除前確認已有必要備份。
