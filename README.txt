# RPpilot static database

Загрузи эти файлы в корень репозитория RPpilot:

- database.json
- database.js

Они должны лежать рядом с:

- index.html
- app.js
- styles.css

В index.html добавь после app.js:

<script src="app.js"></script>
<script src="database.js"></script>

Главный аккаунт уже создан в database.json:

Static ID: 946-447
Login: owner
Password: change-me

После загрузки поменяй пароль в database.json.

Важно:
GitHub Pages не может записывать новых пользователей обратно в database.json.
Файл можно читать с сайта, но нельзя изменять из браузера.
Регистрация без backend будет сохраняться только в localStorage конкретного пользователя.
