# 30 тамактуу меню: локалдык өлчөө

2026-10-15. URL: `http://localhost:8788/jeti-nur-demo-30`. Cloudflare Workers/Hono, Wrangler 4.151.0, локалдык D1/R2.

5 категория, 30 тамак, 90 баа варианты, эки тилдеги узун курам, 4 «Бүттү» белгиси, 31 сүрөт. Ар сүрөт 640×448 px жана 64 279 байт PNG; булар тест үчүн түзүлгөн түстүү үлгүлөр.

| Көрсөткүч | Натыйжа | Чек |
| --- | --- | --- |
| Толук HTML (UTF-8) | 91,595 байт | Маалымат үчүн |
| HTML, gzip | 6336 байт / **6.19 КБ** | <30 КБ — өттү |
| Беттеги inline JavaScript | 1168 байт / **1.14 КБ** | <3 КБ — өттү |
| Өзүнчө service worker | 4002 байт / 3.91 КБ | Биринчи каттоодо жүктөлөт; HTML ичинде эмес |

Көлөмдөр чыныгы HTTP жообунан Node zlib менен өлчөндү. Gzip көрсөткүчүнө CSS, JavaScript жана эки тилдин тексттери кирет; сүрөт байттары өзүнчө.

## Lighthouse 13.5.0

Бардык аудит mobile режиминде, өзүнчө headless Chrome профилинде жүргүзүлдү. Эч бир отчётто runtime error же run warning жок.

| Шарт | Performance | FCP (биринчи текст) | LCP | Speed Index | TBT | CLS |
| --- | --- | --- | --- | --- | --- | --- |
| Lighthouse mobile, стандарттык симуляция | 90/100 | 1.0 s | 1.0 s | 21.6 s | 30 ms | 0 |
| Жай 3G, биринчи өлчөө | 85/100 | 1.5 s | 1.5 s | 1.6 s | 580 ms | 0 |
| Жай 3G, башка тесттер бүткөндөн кийин | 95/100 | 0.9 s | 0.9 s | 1.3 s | 270 ms | 0 |

- Стандарттык mobile: Lighthouse демейки simulated throttling (RTT 150 мс, throughput 1638,4 кбит/с, CPU ×4).
- Жай 3G: чыныгы DevTools throttling, request latency 400 мс, download/upload 400 кбит/с, CPU ×4. Тынч абалдагы өлчөөдө текст **0.9 s** ичинде чыкты; 2 секунд чеги өттү.
- Биринчи жай 3G аудити браузердеги текшерүү менен катар жүргүзүлгөн. Натыйжалар 85 жана 95 болуп айырмаланды; компьютер жүгүнүн таасири болушу мүмкүн. Эки отчёт тең сакталды.
- Стандарттык симуляциядагы Speed Index 21,6 с чыкты; DevTools менен түз өлчөөдө 1,3–1,6 с. Бул көрсөткүчтөрдүн айырмасын жашырбай көрсөттүк; FCP/LCP эки шартта тең 2 секунддан төмөн.

[Mobile HTML отчёт](menu-mobile.report.html) · [Биринчи жай 3G](menu-slow-3g.report.html) · [Тынч абалдагы жай 3G](menu-slow-3g-idle.report.html). Толук JSON'дор ошол эле папкада.

## HTTP жана офлайн текшерүү

- Меню маршруту: бир гана `SELECT html, version FROM published_menus WHERE slug = ? AND is_active = 1`; индексти колдонуу жана кошумча сурамдардын жоктугу Vitest менен текшерилди. Edge кэш урулганда D1 окулбайт.
- HTTP: `Cache-Control: public, max-age=60, stale-while-revalidate=86400`. Сүрөттөрдө immutable кэш.
- Localhost'то 5 GET: TTFB 195, 54, 24, 29, 34 мс; толук HTML 240, 72, 35, 57, 49 мс. Бул 3G же булуттагы тармак убактысы эмес.
- Chrome 360×800: туурасынан ашуу жок; KY/RU бет жаңыртпай которулду; кайра ачканда RU сакталып калды; курамы native details менен ачылды.
- DevTools аркылуу offline коюлуп, мурда ачылбаган query менен экинчи жолу кирилди: 30 тамактуу меню ачылды. Акыркы «Напитки» категориясына өткөндө 6 lazy сүрөт да 640×448 өлчөмү менен ачылды; sticky тизме жогору жакта калды. Андан кийин тармак жөндөөсү калыбына келтирилди.
- TypeScript текшерүүсү жана **110 Vitest тест** өттү.

[Телефон көрүнүшү](menu-mobile.jpg).

## Кайра текшерүү

`npm run demo:local` тест кафени иштетет; дарек localhost:8788/jeti-nur-demo-30. Аны токтотуу: Ctrl+C. Негизги локалдык база өзгөртүлбөйт.

Lighthouse буйругу (Google Chrome орнотулган болушу керек):

```sh
npm exec --yes --package=lighthouse@13.5.0 -- lighthouse http://localhost:8788/jeti-nur-demo-30 --only-categories=performance --output=html --output=json --output-path=reports/menu-mobile --chrome-flags="--headless=new --no-first-run"
```

Жай 3G үчүн кошуңуз: `--throttling-method=devtools --throttling.requestLatencyMs=400 --throttling.downloadThroughputKbps=400 --throttling.uploadThroughputKbps=400 --throttling.cpuSlowdownMultiplier=4`.

Бул локалдык өлчөө; чыныгы Cloudflare edge жана телефондогу мобилдик тармак деплойдон кийин өзүнчө текшерилет.
