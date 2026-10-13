import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "../components/SettingsPage.tsx";

export const Route = createFileRoute("/settings")({ component: SettingsPage });
