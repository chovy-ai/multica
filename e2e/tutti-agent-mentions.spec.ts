import "./env";
import { test, expect } from "@playwright/test";
import pg from "pg";
import { mkdir } from "node:fs/promises";
import { createTestApi } from "./helpers";

const databaseUrl=process.env.DATABASE_URL!;

test("invokes distinct Multica agents sharing Codex and shows both results in the current conversation",async({page,context})=>{
 test.setTimeout(60_000);
 const api=await createTestApi(); const database=new pg.Client(databaseUrl); await database.connect();
 try {
  const workspace=await api.ensureWorkspace();
  const runtime=await api.seedRuntime("Unconnected invocation test runtime","codex");
  const root=await api.createAgent("Default assistant",runtime);
  const design=await api.createAgent("Design reviewer",runtime);
  const code=await api.createAgent("Code reviewer",runtime);
  await database.query("UPDATE agent SET model=$2,instructions=$3,avatar_url=$4 WHERE id=$1",[design.id,"gpt-design","Review design","emoji:🦉"]);
  await database.query("UPDATE agent SET model=$2,instructions=$3,avatar_url=$4 WHERE id=$1",[code.id,"gpt-code","Review code","emoji:🐙"]);
  const user=await database.query('SELECT id FROM "user" WHERE email=$1',[api.getEmail()]);
  const created=await database.query("INSERT INTO chat_session(workspace_id,agent_id,creator_id,title,status,explicitly_created_at) VALUES($1,$2,$3,'Agent collaboration','active',now()) RETURNING id",[workspace.id,root.id,user.rows[0].id]);
  const sessionId=created.rows[0].id;
  await context.addInitScript((token)=>{if(window===window.top)localStorage.setItem("multica_token",token!);},api.getToken());
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(`/${workspace.slug}/conversations?session=${sessionId}`);
  const gui=page.frameLocator('[data-testid="tutti-agent-gui-host"] iframe');
  const editor=gui.getByTestId("agent-gui-composer-editor");
  await expect(editor).toBeVisible({timeout:30_000});
  await editor.fill("@"); await gui.getByRole("tab",{name:"Agents",exact:true}).click();
  await expect(gui.getByRole("option").filter({hasText:design.name})).toBeVisible();
  await expect(gui.getByRole("option").filter({hasText:code.name})).toBeVisible();
  for (const [name, emoji] of [[design.name, "🦉"], [code.name, "🐙"]]) {
   const avatar = gui.getByRole("option").filter({hasText:name}).locator("[data-agent-mention-app-icon] img");
   await expect(avatar).toHaveAttribute("src", /^data:image\/svg\+xml,/);
   expect(decodeURIComponent((await avatar.getAttribute("src"))!)).toContain(emoji);
   await expect.poll(() => avatar.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  }
  await mkdir(".tmp/agent-mentions",{recursive:true});
  await page.screenshot({path:".tmp/agent-mentions/01-defined-agent-directory.png"});
  await gui.getByRole("option").filter({hasText:design.name}).click();
  await editor.press("End"); await editor.pressSequentially(" @"); await gui.getByRole("tab",{name:"Agents",exact:true}).click();
  await gui.getByRole("option").filter({hasText:code.name}).click();
  await editor.press("End"); await editor.pressSequentially(" MENTION_BATCH_CHECK");
  const responsePromise=page.waitForResponse((response)=>response.request().method()==="POST"&&response.url().endsWith(`/api/chat/sessions/${sessionId}/agent-messages`));
  await gui.getByTestId("agent-gui-composer-send").click();
  const response=await responsePromise; expect(response.status()).toBe(201);
  const body=response.request().postDataJSON(); expect(body.agent_ids.sort()).toEqual([design.id,code.id].sort()); expect(body.model).toBeUndefined();
  const result=await response.json(); expect(result.agent_runs).toHaveLength(2);
  const tasks=await database.query("SELECT t.id,t.agent_id,a.model,a.instructions FROM agent_task_queue t JOIN agent a ON a.id=t.agent_id WHERE t.chat_session_id=$1",[sessionId]);
  expect(tasks.rows.map((row)=>row.agent_id).sort()).toEqual([design.id,code.id].sort());
  expect(tasks.rows.find((row)=>row.agent_id===design.id)).toMatchObject({model:"gpt-design",instructions:"Review design"});
  expect(tasks.rows.find((row)=>row.agent_id===code.id)).toMatchObject({model:"gpt-code",instructions:"Review code"});
  // Unconnected test runtimes never launch a CLI. Exercise durable result hydration
  // with test-owned completion rows; handler tests cover claim and completion.
  for(const task of tasks.rows){
   const output=task.agent_id===design.id?"DESIGN_REVIEW_RESULT":"CODE_REVIEW_RESULT";
   await database.query("UPDATE agent_task_queue SET status='completed',completed_at=now(),result=$2 WHERE id=$1",[task.id,JSON.stringify({output})]);
   await database.query("INSERT INTO chat_message(chat_session_id,role,content,task_id) VALUES($1,'assistant',$2,$3)",[sessionId,output,task.id]);
  }
  await page.reload();
  await expect(gui.getByText("DESIGN_REVIEW_RESULT",{exact:false})).toBeVisible();
  await expect(gui.getByText("CODE_REVIEW_RESULT",{exact:false})).toBeVisible();
  await expect(gui.locator("strong").filter({hasText:design.name})).toBeVisible();
  await expect(gui.locator("strong").filter({hasText:code.name})).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`session=${sessionId}$`));
  await page.screenshot({path:".tmp/agent-mentions/02-both-agent-results.png"});
 } finally {await database.end(); await api.cleanup(); await api.deleteWorkspace();}
});
