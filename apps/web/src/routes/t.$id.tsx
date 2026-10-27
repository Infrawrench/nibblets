import { createFileRoute } from "@tanstack/react-router";
import { ThirdPartyPage } from "../components/thirdparty/ThirdPartyPage.tsx";

export const Route = createFileRoute("/t/$id")({
  component: function ThirdPartyRoute() {
    const { id } = Route.useParams();
    return <ThirdPartyPage key={id} id={id} />;
  },
});
