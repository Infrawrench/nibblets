/**
 * T3 Code's MCP tools a nibblet may be granted, by system, each its own
 * scope. Kept by hand from T3 Code's source (`apps/server/src/mcp/toolkits`
 * in pingdotgg/t3code), as of 0.1.3 at 9826dbb.
 *
 * Only tools an agent T3 Code didn't start can call are here. Ones that act
 * as a T3 Code thread itself (declared `readsAsCaller` or `actsAsCaller`:
 * delegating to sub-agents, previews, devices, HTML renders, worktree
 * hand-offs, asking for secrets) refuse an outside agent, so they're left
 * out. A tool T3 Code adds isn't listed to any nibblet until it's added here.
 *
 * `does` is what T3 Code lets it do: `reads` works on a read-only sign-in,
 * `changes` needs one that may act, and `both` (T3 Code's `either`) reads on
 * either and changes only on one that may act.
 */

export type ToolUse = "reads" | "changes" | "both";

export interface T3Tool {
  name: string;
  /** What ticking it lets a nibblet do, for its settings. */
  label: string;
  does: ToolUse;
}

export interface T3System {
  title: string;
  tools: T3Tool[];
}

export const T3_SYSTEMS: readonly T3System[] = [
  {
    title: "Threads",
    tools: [
      { name: "t3_thread_list", label: "List threads", does: "reads" },
      { name: "t3_thread_read", label: "Read a thread and its activity", does: "reads" },
      { name: "t3_thread_search", label: "Search threads", does: "reads" },
      { name: "t3_thread_wait", label: "Wait for a thread's run to finish", does: "reads" },
      { name: "t3_thread_launch", label: "Start a thread", does: "changes" },
      { name: "t3_thread_send", label: "Message, steer or restart a thread", does: "changes" },
      { name: "t3_thread_interrupt", label: "Interrupt a thread's run", does: "changes" },
      {
        name: "t3_pending_request",
        label: "Read and answer a thread's questions",
        does: "both",
      },
      { name: "t3_queue", label: "See and change a thread's queued messages", does: "both" },
      {
        name: "t3_thread_configure",
        label: "See and change a thread's provider and model",
        does: "both",
      },
      { name: "t3_thread_update", label: "Rename a thread", does: "changes" },
      {
        name: "t3_thread_organize",
        label: "Pin, snooze, settle or archive a thread",
        does: "changes",
      },
      {
        name: "t3_thread_transfer",
        label: "Fork a thread, or merge one back",
        does: "both",
      },
      { name: "t3_workflow_stop", label: "Stop a thread's Claude workflow", does: "changes" },
    ],
  },
  {
    title: "Attachments",
    tools: [
      { name: "t3_attachment_prepare_upload", label: "Upload a file", does: "changes" },
      { name: "t3_attachment_discard", label: "Discard an upload", does: "changes" },
      {
        name: "t3_thread_send_attachments",
        label: "Send uploads to a thread",
        does: "changes",
      },
    ],
  },
  {
    title: "Projects",
    tools: [
      { name: "t3_project_list", label: "List projects", does: "reads" },
      { name: "t3_project_read", label: "Read a project and its scripts", does: "reads" },
      { name: "t3_worktree_list", label: "List a thread's branches and checkouts", does: "reads" },
      { name: "t3_project_create", label: "Add a project", does: "changes" },
      { name: "t3_project_clone", label: "Clone a repository", does: "changes" },
      { name: "t3_project_update", label: "Change a project's settings", does: "changes" },
      { name: "t3_project_delete", label: "Delete a project", does: "changes" },
    ],
  },
  {
    title: "Pull requests",
    tools: [
      { name: "list_thread_pull_requests", label: "List a thread's pull requests", does: "reads" },
      { name: "read_pull_request_guide", label: "Read a pull request's guide", does: "reads" },
      { name: "link_pull_request", label: "Link a pull request to a thread", does: "changes" },
      { name: "unlink_pull_request", label: "Unlink a pull request", does: "changes" },
      {
        name: "watch_pull_request",
        label: "Watch a pull request's checks and reviews",
        does: "changes",
      },
      { name: "unwatch_pull_request", label: "Stop watching a pull request", does: "changes" },
      {
        name: "write_pull_request_guides",
        label: "Write pull requests' review guides",
        does: "changes",
      },
    ],
  },
  {
    title: "Scheduled tasks",
    tools: [
      { name: "list_scheduled_tasks", label: "List scheduled tasks", does: "reads" },
      { name: "schedule_task", label: "Schedule a task, or change one", does: "changes" },
      { name: "run_scheduled_task_now", label: "Run a scheduled task now", does: "changes" },
      { name: "delete_scheduled_task", label: "Delete a scheduled task", does: "changes" },
    ],
  },
  {
    title: "Environment",
    tools: [
      {
        name: "orchestrator_capabilities",
        label: "List providers and models",
        does: "reads",
      },
      { name: "t3_environment_read", label: "Read the environment's preferences", does: "reads" },
      {
        name: "t3_environment_preferences_update",
        label: "Change the environment's preferences",
        does: "changes",
      },
      { name: "t3_environment_links", label: "List linked machines", does: "reads" },
      { name: "t3_environment_link", label: "Ask to link another machine", does: "changes" },
      { name: "t3_environment_unlink", label: "Forget a linked machine", does: "changes" },
    ],
  },
];

/** Every catalogued tool, by name. */
export const T3_TOOLS: ReadonlyMap<string, T3Tool> = new Map(
  T3_SYSTEMS.flatMap((system) => system.tools.map((tool) => [tool.name, tool])),
);
