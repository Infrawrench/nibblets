import { createFileRoute } from "@tanstack/react-router";
import { HamsterLook, defaultHamsterLook, type NibbletStatus } from "@nibblet/protocol";
import { Hamster } from "../components/hamster/Hamster.tsx";
import { withField } from "../components/hamster/HamsterEditor.tsx";

/** Every option side by side, for working on the drawing. Not linked from the app. */
export const Route = createFileRoute("/hamsters")({ component: Gallery });

const statuses: NibbletStatus[] = ["idle", "working", "stopped", "error"];

function Gallery() {
  const s = HamsterLook.shape;
  const rows = [
    s.fur.options.map((v) => withField(defaultHamsterLook, "fur", v)),
    s.pattern.options.map((v) => withField(defaultHamsterLook, "pattern", v)),
    s.ears.options.map((v) => withField(defaultHamsterLook, "ears", v)),
    s.eyes.options.map((v) => withField(defaultHamsterLook, "eyes", v)),
    s.mouth.options.map((v) => withField(defaultHamsterLook, "mouth", v)),
    s.cheeks.options.map((v) => withField(defaultHamsterLook, "cheeks", v)),
    s.accessory.options.map((v) => withField(defaultHamsterLook, "accessory", v)),
  ];
  return (
    <div className="flex-1 overflow-auto p-6">
      {rows.map((row, i) => (
        <div key={i} className="mb-3 flex flex-wrap gap-3">
          {row.map((look, j) => (
            <Hamster key={j} look={look} size={120} />
          ))}
        </div>
      ))}
      <div className="flex gap-3">
        {statuses.map((st) => (
          <Hamster key={st} look={defaultHamsterLook} size={120} status={st} />
        ))}
        {[16, 20, 22, 28].map((size) => (
          <Hamster
            key={size}
            look={{ ...defaultHamsterLook, accessory: "party_hat" }}
            size={size}
          />
        ))}
      </div>
    </div>
  );
}
