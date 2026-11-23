# vendor

| 檔案 | 說明 |
|---|---|
| `cfr-0.152.jar` | [CFR](https://www.benf.org/other/cfr/) 0.152 Java 反編譯器，MIT 授權（`CFR-LICENSE.txt`）。未經修改，取自 Maven Central：<https://repo1.maven.org/maven2/org/benf/cfr/0.152/cfr-0.152.jar> |

驗證：

- SHA-1（Maven Central 公布）：`48ef4892cfe8feffddbbd0ff077735140557db74`
- SHA-256：`f686e8f3ded377d7bc87d216a90e9e9512df4156e75b06c655a16648ae8765b2`

```bash
shasum -a 1 vendor/cfr-0.152.jar
```

只有在使用者開啟 `.class` 檔且電腦上有 Java 時，才會以 `java -jar vendor/cfr-0.152.jar <檔案> --silent true` 執行；不連網，輸出只顯示在唯讀分頁中。
