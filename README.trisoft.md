# Trisoft: дополнения к Kan

Форк: https://github.com/Subnakich/kan. Рабочая ветка: `feat/trisoft-task-control`.
Исходная база: `d0809f05422bcc3f1acb98804d44671207e7ed9d`. Upstream: `kanbn/kan`.
Лицензия upstream сохранена. Этот файл — карта доработок, не замена Git и резервной копии БД.

## Функции

- На пустой доске включается Task control: `Review → Queue → In Progress → Done`, отдельно `Blocked`. Роли колонок не зависят от их отображаемых названий.
- Основной ответственный берется из штатных участников карточки. Единственный участник назначается автоматически; при нескольких основной выбирается явно. Второго справочника пользователей нет.
- Срок до часов и минут, ввод/отображение в `Europe/Moscow`, API хранит момент в UTC. Срок **необязателен**. Без срока нет напоминания о приближении срока, но контроль зависания возможен.
- В Review разрешены неизвестные ответственный и срок. Для подтверждения в Queue нужны название, описание, ответственный. В Blocked нужна причина.
- Массовое ревью: кнопка «Ревью карточек» на доске, выбор отдельных карточек или готовых, подтверждение до 100 за раз. Каждая карточка проверяется и переносится отдельно; неполные, измененные или уже вышедшие из Review не переносятся. Выводится результат по каждой отклоненной карточке. Срок не требуется.
- Перенос карточки работает и на заголовок/отступы колонки. Правила переходов Task control при этом не обходятся.
- Импорт поручений из JSON через Telegram-бота — только в Review, с цитатой источника, критериями, метками и чеклистом. Повторный импорт защищен от дублей.
- Журнал изменений и счетчики ревизий позволяют боту контролировать срок и время в колонке. Комментарий не сбрасывает это время.
- Выбор проекта Redmine, preview, подтверждение и однократная выгрузка снимка. После выгрузки контроль остается в Kan; дальнейшей двусторонней синхронизации нет.
- Интерфейс использует компоненты Kan и локализацию, включая русский язык.

Удаление лишней карточки Task control — физическое удаление карточки и дочерних записей; остается импортный tombstone против повторного создания. Обычные доски сохраняют штатный soft delete. Удаление карточки не удаляет задачу Redmine.

## Границы реализации

Kan предоставляет данные и очередь. Telegram-напоминания, график пн–пт 10–19, привязки Telegram/Redmine и создание Redmine issue выполняет **отдельный бот** (`/Users/subnak/dev/redmine-bot`). Их production-работоспособность нельзя доказать тестом Kan с mock.

Отправка транскрибации в ИИ — ручной внешний этап; Kan сам ее не транскрибирует. Оригиналы вложений не гарантированно переносятся в Redmine: нужна отдельная проверка S3 и загрузчика бота. Редактор критериев и UI настройки порогов зависания не реализованы полностью.

## Техническая карта

| Слой              | Основные файлы / назначение                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI доски/карточки | `apps/web/src/views/board/components/TaskBoardControl.tsx`, `BulkReviewForm.tsx`, `dnd/collision.ts`, `card/components/TaskControlPanel.tsx`, `RedmineExport.tsx`, штатные Card/MemberSelector/DueDateSelector/ListSelector |
| tRPC              | `packages/api/src/routers/task-control.ts`, подключение в `root.ts`, проверки в штатном `routers/card.ts`                                                                                                                   |
| Сервисный REST    | `apps/web/src/pages/api/integrations/v1/[...path].ts`; отдельная серверная авторизация в `packages/api/src/trpc.ts` и `trpc-context.ts`                                                                                     |
| БД                | `packages/db/src/schema/task-control.ts`, поля `cards/boards/lists`, `repository/task-control.repo.ts`, `redmine-request.repo.ts`                                                                                           |
| Экспорт polling   | `packages/api/src/utils/redmine-queue.ts`; `task-gateway.ts` содержит переиспользуемые схемы ответов, а не обязательное входящее соединение                                                                                 |
| Время / whitelist | `packages/shared/src/utils/task-time.ts`, `packages/api/src/utils/integration-ip-policy.ts`                                                                                                                                 |
| Auth / runtime    | `packages/auth`, миграция API keys, Dockerfile, lockfile/catalog; Next/Better Auth/Drizzle/native sharp обновлены вместе                                                                                                    |
| Эксплуатация      | `deploy/`, проверки `tools/security/`, локальные mock/smoke в `tools/task-control/`                                                                                                                                         |
| Контракты         | [сервисный API](docs/task-control.md), [polling бота](docs/bot-redmine-polling-contract.md), [импорт встреч](docs/meeting-task-import.md)                                                                                   |

Миграции (примененные файлы **не редактировать**):

1. `20261006104334_AddTaskControl.sql` — поля/таблицы, guards, журнал и ревизии.
2. `20261006105305_FixTaskControlInsert.sql` — корректировка вставки.
3. `20261006123827_UpgradeApiKeyPlugin.sql` — новая модель API keys с сохранением существующих данных.
4. `20261006142318_NativeTaskOwnership.sql` — ответственный из штатных участников.
5. `20261006153952_AddRedminePollingQueue.sql` — устойчивая очередь и lease.

Сохранять также `meta/_journal.json` и все соответствующие `*_snapshot.json`. Не выполнять `db:push` на production вместо миграций.

## Интеграция и безопасность

Бот инициирует все соединения: HTTPS к `https://kanban.trisoft.ru/api/integrations/v1`. Серверу бота не нужны домен, входящий порт, VPN или gateway URL.

- `TASK_CONTROL_SERVICE_TOKEN` — отдельный секрет сервиса, не пользовательский `kan_…` ключ. Не передавать в браузер/ИИ/JSON поручений.
- `TASK_CONTROL_INSTANCE_ID` — стабильная идентичность установки, не менять после начала импорта.
- `TASK_CONTROL_ALLOWED_IPS` — фиксированный внешний IP бота или CIDR; в production обязателен.
- `TASK_CONTROL_TRUSTED_PROXIES` — точный адрес Nginx, видимый контейнеру; не вся Docker-подсеть. Nginx должен корректно перезаписывать `X-Forwarded-For`.
- `TASK_CONTROL_GATEWAY_URL/TOKEN` — исторические параметры, polling их не использует.
- В бот дополнительно задаются разрешенные доски/проекты и привязки пользователей; service token не отменяет проверки прав пользователя.

Worker: `claim → lease → result`; lease 120 секунд, продление каждые 30–40 секунд, обычный polling каждые 2–5 секунд. Неизвестный итог Redmine POST нельзя автоматически повторять: сначала проверка операции. Подробные тела и endpoints — в [контракте](docs/bot-redmine-polling-contract.md).

Импорт: ключ `instance_id:meeting.id:task.id`; хеш канонического содержимого. Повтор — та же карточка; измененное содержимое — конфликт; удаленный ключ — tombstone. Не менять ID, чтобы обойти конфликт.

## Запуск и проверка

Стек: Node 22+, pnpm 9.14.2, Next.js/React/tRPC, PostgreSQL/Drizzle, Better Auth; Docker Compose и Nginx для self-hosting. Локальный Compose использует собственную PostgreSQL 15 и отдельные volumes, не Redmine PostgreSQL 11.

```sh
docker compose -f compose.local.yml up -d --build
docker compose -f compose.local.yml exec -T web node tools/task-control/seed-local.mjs
```

Адрес `http://localhost:3100`; тестовые данные/учетная запись описаны в [локальной инструкции](docs/task-control.md). Не использовать demo-секреты для production и не запускать seed на рабочей БД.

Перед коммитом/слиянием:

```sh
pnpm lint
pnpm typecheck
pnpm --filter @kan/api test
pnpm --filter @kan/shared test
pnpm --filter @kan/web test
python3 tools/security/polling-layout.test.py
bash tools/security/polling-backup.test.sh
bash tools/security/polling-gateway.test.sh
git diff --check
```

Проверить вручную: ответственного через Members, необязательный срок, Review→Queue, Blocked, точное время, импорт/retry/delete, отказ без токена и с чужого IP, экспорт через worker и восстановление после рестарта. Общие lint/typecheck могут выявить upstream-проблемы вне измененных пакетов; фиксировать их отдельно и запускать проверки затронутых пакетов, не считать общий gate зеленым.

## Production и восстановление

Постоянная структура: `/opt/kanban/compose.yml`, `/opt/kanban/.env`, `/opt/kanban/backups/`. Секреты задаются при запуске контейнера, не вшиты в образ. После изменения `.env` контейнер требуется **пересоздать**; одного `restart` недостаточно.

Для установленного flat-layout использовать только соответствующий проверенный upgrade-путь из [deploy/README.md](deploy/README.md). Старые install/upgrade скрипты относятся к указанным в них переходам; не запускать их произвольно на актуальной установке.

Перед изменением схемы: backup БД Kan, восстановление в отдельную БД, проверка fingerprints, проверка auth/health и сохранности задач. Redmine/его volume не трогать. После открытия сервиса пользователям нельзя вслепую восстанавливать старый dump: потеряются новые действия. Git хранит код, **не данные БД**.

Завершение текущего polling-upgrade на production пока не подтверждено. Подтверждение — успешный финал root-скрипта, внешние проверки и `capabilities` с `redmine_polling_queue_v1`; само наличие коммита этого не доказывает.

## Как обновлять форк без потери доработок

Не использовать GitHub Discard commits, `reset --hard`, принудительный push или замену ветки upstream. Обновлять через merge в отдельной ветке.

1. Сохранить изменения коммитами в `feat/trisoft-task-control`, отправить в свой origin. Рабочее дерево должно быть чистым.
2. Проверить `git remote -v`. Если upstream еще отсутствует: `git remote add upstream https://github.com/kanbn/kan.git`. При другом существующем upstream сначала проверить его, не заменять молча.
3. Выполнить команды ниже; для каждого обновления выбрать уникальные имена backup/integration.

```sh
git switch feat/trisoft-task-control
git fetch origin
git fetch upstream
git branch backup/trisoft-before-upstream-YYYYMMDD
git push origin backup/trisoft-before-upstream-YYYYMMDD
git switch -c merge/upstream-YYYYMMDD
git merge --no-ff upstream/main
```

4. Разрешить конфликты по технической карте: штатные Card/MemberSelector/DueDateSelector, auth/API keys, IP-политика, schema/repositories, migrations, каталоги переводов, lockfile, Docker tracing/native modules и очередь. Не менять уже примененные SQL. При столкновении веток миграций отдельно проверить порядок journal/snapshots на копии БД и создать новые корректирующие миграции при необходимости.
5. Пройти проверки выше и миграции на восстановленной копии **рабочей** БД. Проверить контракт совместно с текущей версией бота; mock не заменяет интеграционный тест.
6. Закоммитить merge, затем вернуть проверенный результат в feature-ветку:

```sh
git switch feat/trisoft-task-control
git merge --ff-only merge/upstream-YYYYMMDD
git push origin feat/trisoft-task-control
```

Если `--ff-only` не проходит, ветка изменилась параллельно: заново согласовать и проверить merge, не делать force push. Деплой — отдельный шаг после backup/restore, не часть Git-синхронизации.
