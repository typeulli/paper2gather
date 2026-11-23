import Heading from "@tiptap/extension-heading";
import { booleanAttribute, stringAttribute } from "../nodes/shared";

/** Heading with a stable id/label for cross references and an optional "unnumbered" flag (\section*). */
export const PaperHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      id: stringAttribute("id"),
      label: stringAttribute("label"),
      numbered: booleanAttribute("numbered", true),
    };
  },
}).configure({ levels: [1, 2, 3] });
