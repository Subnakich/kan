import {
  demoEmail,
  demoPassword,
  importPayload,
  integration,
  login,
  rpc,
} from "./client.mjs";

const cookie = await login();
const workspaces = (await rpc(cookie, "workspace.all", null)).map(
  (item) => item.workspace,
);
const workspace =
  workspaces.find((item) => item.name === "Trisoft — local demo") ??
  (await rpc(
    cookie,
    "workspace.create",
    { name: "Trisoft — local demo", slug: "trisoft-demo" },
    true,
  ));
const boards = await rpc(cookie, "board.all", {
  workspacePublicId: workspace.publicId,
});
const board =
  boards.find((item) => item.name === "Meeting tasks") ??
  (await rpc(
    cookie,
    "board.create",
    {
      workspacePublicId: workspace.publicId,
      name: "Meeting tasks",
      lists: ["Review", "Queue", "In Progress", "Blocked", "Done"],
      labels: [],
    },
    true,
  ));
await rpc(
  cookie,
  "taskControl.enable",
  { boardPublicId: board.publicId },
  true,
);
const members = (await integration(`/boards/${board.publicId}/members`)).data;
const member = members[0];
const tasks = [
  ["review", "Проверить поручения после планерки", null],
  ["clarify", "Уточнить ответственного и срок поручения", null],
  ["queue", "Подготовить файл задач для Telegram-бота", "queue"],
  ["progress", "Проверить Kan и согласовать процесс", "in_progress"],
  ["blocked", "Согласовать доступ к тестовому Redmine", "blocked"],
  ["done", "Определить колонки и правила работы", "done"],
];
const state = await rpc(cookie, "taskControl.board", {
  boardPublicId: board.publicId,
});
for (const [id, title, role] of tasks) {
  const payload = importPayload(
    board.publicId,
    id === "clarify" ? null : member,
    id,
    title,
    id === "clarify" ? null : "2026-10-07T15:30:00+03:00",
  );
  if (id === "clarify") {
    payload.task.due_text = "На следующей неделе";
    payload.task.review_notes = [
      "В разговоре не назвали ответственного и точное время; уточнить на Review.",
    ];
    const { hash } = await import("./client.mjs");
    payload.payload_hash = hash({
      board_id: payload.board_id,
      meeting: payload.meeting,
      task: payload.task,
    });
  }
  const result = await integration(
    "/imports/cards",
    "POST",
    payload,
    payload.external_key,
  );
  if (![200, 201, 410].includes(result.status))
    throw new Error(JSON.stringify(result));
  if (result.status !== 201 || !role) continue;
  const card = result.data.card_id;
  await rpc(
    cookie,
    "card.update",
    {
      cardPublicId: card,
      listPublicId: state.columns.find((item) => item.role === "queue")
        .publicId,
      index: 0,
    },
    true,
  );
  if (role === "blocked")
    await rpc(
      cookie,
      "taskControl.update",
      {
        cardPublicId: card,
        blocker_reason:
          "Ожидаем параметры тестового проекта. Рабочие данные не используем.",
      },
      true,
    );
  if (role !== "queue")
    await rpc(
      cookie,
      "card.update",
      {
        cardPublicId: card,
        listPublicId: state.columns.find((item) => item.role === role).publicId,
        index: 0,
      },
      true,
    );
}
console.log(
  JSON.stringify(
    {
      url: `http://localhost:3100/boards/${board.publicId}`,
      board: board.publicId,
      workspace: workspace.publicId,
      email: demoEmail,
      password: demoPassword,
      note: "Local demo credentials only",
    },
    null,
    2,
  ),
);
