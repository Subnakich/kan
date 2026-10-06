# Kan → Redmine: контракт polling v1 для бота

Статус: реализовано и проверено локально в Kan; завершение обновления production до polling-версии не подтверждено. Worker бота ведется отдельно. Реальный Redmine/Telegram в локальных проверках не используется.

## Соединение и настройки

Только **бот → Kan** по HTTPS. На сервере бота не нужны входящие порты, gateway-процесс, домен, VPN или SSH-туннель.

- Рабочая база URL: `https://kanban.trisoft.ru/api/integrations/v1`.
- Доска: `ec35ftst8whl`.
- Все endpoints используют `Authorization: Bearer <KAN_SERVICE_TOKEN>` и `Content-Type: application/json` для POST. Это существующий service token Kan, не `kan_…` user API key.
- IP бота `46.203.233.110` должен быть разрешен в Nginx и `TASK_CONTROL_ALLOWED_IPS`. `TASK_CONTROL_TRUSTED_PROXIES` задается отдельно точным адресом Nginx; ожидаемый Docker gateway на текущем хосте — `172.19.0.1`.
- Проверить `GET /capabilities`: `features` содержит `redmine_polling_queue_v1`. Если нет — новый worker не запускать.
- `TASK_CONTROL_GATEWAY_URL` и `TASK_CONTROL_GATEWAY_TOKEN` в новой версии Kan не используются. В боте убрать обязательность `KAN_GATEWAY_TOKEN` для импорта/напоминаний/worker, не запуская `kan_gateway`.
- Сохранить `KAN_INSTANCE_ID`, разрешенные доски/проекты, пользовательский permission API key, привязки Kan ↔ Telegram ↔ Redmine и проверенные workflow manifests.

## Endpoints для worker

Все пути ниже добавляются к базе URL.

| Метод | Путь                                    | Назначение                                                    |
| ----- | --------------------------------------- | ------------------------------------------------------------- |
| POST  | `/redmine/requests/claim`               | Атомарно взять запросы в работу                               |
| POST  | `/redmine/requests/{request_id}/lease`  | Продлить текущую аренду                                       |
| POST  | `/redmine/requests/{request_id}/result` | Подтвердить результат; повтор идемпотентен                    |
| GET   | `/redmine/requests/{request_id}`        | Проверить принятый результат после потери ответа              |
| GET   | `/cards/{card_id}`                      | Перечитать актуальный снимок и ревизию                        |
| PUT   | `/cards/{card_id}/redmine-link`         | Записать связь с созданной задачей; прежний контракт сохранен |

### Получение запросов

```json
{ "board_ids": ["ec35ftst8whl"], "limit": 1 }
```

`board_ids`: 1–100 публичных ID; передавать только разрешенные конфигурацией бота доски. `limit`: 1–10, по умолчанию 1. Рекомендуется опрос каждые 2–5 секунд, без параллельных циклов одного worker. Не брать пачку больше числа свободных исполнителей.

Ответ:

```json
{
  "items": [
    {
      "request_id": "request00001",
      "kind": "preview",
      "actor_member_id": "member000001",
      "card_id": "card00000001",
      "board_id": "ec35ftst8whl",
      "workspace_id": "workspace001",
      "expected_revision": 7,
      "request": {
        "method": "POST",
        "path": "/redmine/exports/preview",
        "body": {
          "actor_member_id": "member000001",
          "card_id": "card00000001",
          "expected_revision": 7,
          "project_id": 1,
          "tracker_id": 1,
          "status_id": 1,
          "priority_id": 2,
          "custom_fields": []
        },
        "idempotency_key": null
      },
      "lease_token": "f0b11a5f-90d7-4e6d-999a-341d1cc05881",
      "lease_expires_at": "2026-10-06T18:00:00.000Z",
      "attempts": 1
    }
  ],
  "lease_seconds": 120
}
```

Пустая очередь: `{"items":[],"lease_seconds":120}`. Все ID Kan публичные, длина 12. `expected_revision` — положительное целое. `lease_token` — непрозрачный UUID; не показывать пользователю и не писать в обычные логи.

## Диспетчер запросов: переиспользовать существующий RedmineExportService

`request.method/path/body` — описание вызова, **не адрес для HTTP-запроса**. Worker вызывает методы существующего сервиса внутри процесса. Не запускать прежний HTTP gateway и не выполнять произвольные URL из очереди.

| kind        | request                                                        | Вызов в боте                                                                             | Ожидаемый result                                   |
| ----------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `projects`  | GET `/redmine/projects?actor_member_id=…&cursor=…`             | `export_service.projects(actor, cursor)`                                                 | `{items:[{id,name}],has_more,next_cursor,demo}`    |
| `options`   | GET `/redmine/projects/{project_id}/options?actor_member_id=…` | `export_service.options(actor, project_id)`                                              | `{trackers,statuses,priorities,custom_fields}`     |
| `preview`   | POST `/redmine/exports/preview`                                | `export_service.preview(body)`                                                           | `{preview_id,expires_at,snapshot,warnings,errors}` |
| `export`    | POST `/redmine/exports`                                        | `ExportJobs.enqueue(actor, preview_id, idempotency_key)`                                 | `{operation_id,status,redmine_link,errors}`        |
| `operation` | GET `/redmine/exports/{operation_id}?actor_member_id=…`        | `ExportJobs.operation(actor,id)` для `job-…`, иначе `export_service.operation(actor,id)` | `{operation_id,status,redmine_link,errors}`        |

Проверять соответствие kind/пути/метода, actor из envelope и body/query, card ID и board/workspace allowlist. На стороне Kan actor получен из серверной сессии и не принимается от браузера. Перед lease выдачей Kan заново проверяет активность карточки, участника и `card:edit`. **Бот сохраняет все прежние проверки эффективных прав Kan/Redmine и назначения ответственного** — service token не дает пользователю административные права Redmine.

Для options: `trackers/statuses/priorities` — массивы `{id:integer,name:string}`. `custom_fields` — массив `{id,name,required:boolean,format:string,choices?:string[]}`. Правила обязательных workflow-полей по-прежнему задаются проверенным manifest в боте.

Для preview: срок действия 10 минут; snapshot содержит `card_id` и `revision`, совпадающие с envelope. Kan не принимает snapshot другой карточки/ревизии или срок действия больше 11 минут. При подтверждении Kan проверяет принадлежность preview этой карточке/actor, отсутствие errors, срок действия и актуальную ревизию. Worker повторно проверяет актуальный снимок непосредственно перед Redmine POST, как существующий сервис.

Для export/operation: `status` = `pending|created|linked|failed|unknown`, `redmine_link` = null или объект с `display_id` и HTTP(S) `url`, `errors` = массив строк. `operation_id` — ID журнала/фоновой операции бота, **не** `request_id` Kan. `pending` означает принятый durable bot job; Kan-запрос можно завершить, дальнейший статус запрашивается отдельным `operation`.

## Продление lease

```json
{ "lease_token": "f0b11a5f-90d7-4e6d-999a-341d1cc05881" }
```

Ответ: `{request_id,lease_expires_at}`. Продлевать каждые 30–40 секунд, если обработка еще идет. Просроченную аренду продлить нельзя; 409 не игнорировать.

## Отправка результата

POST `/redmine/requests/{request_id}/result`:

```json
{
  "lease_token": "f0b11a5f-90d7-4e6d-999a-341d1cc05881",
  "state": "completed",
  "result": {
    "items": [{ "id": 1, "name": "Проект" }],
    "has_more": false,
    "next_cursor": null,
    "demo": false
  },
  "error": null
}
```

Это пример для `kind=projects`; для других kind `result` — объект из таблицы выше, **без обертки kind/data**. Сервер проверяет схему по kind сохраненного запроса.

Подтвержденный отказ, без неопределенного создания задачи:

```json
{
  "lease_token": "f0b11a5f-90d7-4e6d-999a-341d1cc05881",
  "state": "failed",
  "result": null,
  "error": "Нет прав на создание задачи в выбранном проекте"
}
```

Неопределенный результат export:

```json
{
  "lease_token": "f0b11a5f-90d7-4e6d-999a-341d1cc05881",
  "state": "unknown",
  "result": null,
  "error": "Нужно сверить журнал экспорта с Redmine; повторное создание запрещено"
}
```

`unknown` допустим только для kind=export. `error` — понятный безопасный текст до 2000 символов, не исключение с токенами/SQL/телом HTTP. `completed` требует result и error=null; failed/unknown — result=null и непустой error. Тело HTTP до 256 KiB.

Ответ POST и GET статуса имеют одинаковую форму:

```json
{
  "request_id": "request00001",
  "card_id": "card00000001",
  "kind": "projects",
  "state": "completed",
  "result": {
    "kind": "projects",
    "data": {
      "items": [],
      "has_more": false,
      "next_cursor": null,
      "demo": false
    }
  },
  "error": null,
  "updated_at": "2026-10-06T18:00:00.000Z"
}
```

Здесь result **обернут** в `{kind,data}` для типизированного UI. Для queued/leased/failed/unknown result=null, если worker еще не прислал типизированный результат. Lease token, actor и transport body в этом статусе не возвращаются.

## Гарантии и восстановление

1. PostgreSQL хранит очередь независимо от web/браузера. Claim атомарный с блокировкой строк и SKIP LOCKED; параллельным worker не выдаются одни и те же активные lease.
2. Read/preview/operation после истечения lease могут выдаваться повторно с новым токеном, максимум 10 попыток. Preview не создает Redmine issue, но worker должен сохранять результат по request_id для повторного использования.
3. **Export после истечения lease переходит в unknown и не выдается заново.** Запрос мог дойти до Redmine. Не сбрасывать очередь/журнал ради нового POST.
4. Один export на карточку в Kan, независимо от nonce/preview/actor. Повтор от исходного actor возвращает тот же request_id; другой actor не получает чужую операцию. Failed export также требует разбора администратором, не автоматически нового экспорта.
5. Сохранять request_id, lease token, payload fingerprint и результат в SQLite worker **до** выполнения/ack; использовать существующий durable ExportJobs и журнал Redmine, общий с ботом. Не запускать второй Telegram polling-процесс.
6. Повтор identical result POST идемпотентен. При потере ответа сначала GET статуса. При 409 нового lease старый worker больше не пишет результат. Для unknown export прежний token позволяет дописать результат после сверки журнала; новые worker восстанавливают token из своего журнала, не через повторный claim.
7. `state=completed` с export result `status=unknown` тоже допустим: неопределенность зафиксирована существующим журналом бота. Вызывать только operation/reconcile, не новый export.
8. При `linked` сначала PUT redmine-link на карточке. Kan сверяет существующую связь с результатом, иначе acknowledgement возвращает 409. Изменения в Kan после экспорта не синхронизируются обратно в Redmine; уведомления продолжаются в Kan.
9. Коды: 401 токен; 403 IP/права; 404 объект; 409 ревизия/lease/конфликт; 422 схема; 429 лимит; 500 неизвестный сбой. При HTTP 5xx/обрыве export не считать безопасно не выполненным.

## Приемка бота в отдельном чате

- Worker использует эти четыре новых endpoints; никакого входящего gateway.
- Справочники доступны только тому actor, для которого запрос создал Kan; бот возвращает только разрешенные ему проекты/поля.
- Канбан UI: проекты → поля → preview → confirm → pending → operation → linked; состояние export восстанавливается после перезагрузки карточки.
- Проверить два worker, перезапуски, потерю ответа после Redmine POST и после acknowledgement, смену прав/ревизии, истечение preview/lease, deleted/archived карточку и дубли.
- Импорт, напоминания, учет времени и прежние SQLite fingerprints не меняются. Тестировать с mock Redmine/Telegram, без рабочих задач и сообщений. Деплой отдельно после проверки обеих сторон.

Схемы: `packages/api/src/utils/redmine-queue.ts`; обработчик HTTP: `apps/web/src/pages/api/integrations/v1/[...path].ts`; очередь SQL: `packages/db/src/repository/redmine-request.repo.ts`. Новая миграция: `20261006153952_AddRedminePollingQueue`.
