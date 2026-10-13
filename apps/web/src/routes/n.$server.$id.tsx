import { createFileRoute } from "@tanstack/react-router";
import { NibbletPage } from "../components/NibbletPage.tsx";

export const Route = createFileRoute("/n/$server/$id")({
  component: function NibbletRoute() {
    const { server, id } = Route.useParams();
    return <NibbletPage key={`${server}/${id}`} server={server} id={id} />;
  },
});
