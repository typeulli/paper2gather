import { Extension, type ChainedCommands } from "@tiptap/core";
import {
  FONT_FAMILY_FROM_VARS,
  FONT_SIZE_RANGE,
  isColor,
  isKoreanFontKey,
  isLatinFontKey,
  isTextAlign,
  KOREAN_FONTS,
  LATIN_FONTS,
  type KoreanFontKey,
  type LatinFontKey,
  type TextAlign,
} from "@/lib/paper/format";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    textFormat: {
      /** Font for Latin text; null restores the paragraph style's */
      setLatinFont: (font: LatinFontKey | null) => ReturnType;
      /** Font for Korean text; null restores the paragraph style's */
      setKoreanFont: (font: KoreanFontKey | null) => ReturnType;
      /** pt; null restores the paragraph style's size */
      setFontSizePt: (size: number | null) => ReturnType;
      /** #rrggbb; null restores the paragraph style's color */
      setTextColor: (color: string | null) => ReturnType;
      /** null restores the paragraph style's alignment */
      setBlockAlign: (align: TextAlign | null) => ReturnType;
      /** Removes character formatting and alignment, keeping links and comments. */
      clearTextFormatting: () => ReturnType;
    };
  }
}

const ALIGNABLE = ["paragraph", "heading"];
const KEEP_ON_CLEAR = new Set(["link", "comment"]);

function validSize(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= FONT_SIZE_RANGE.min && n <= FONT_SIZE_RANGE.max ? n : null;
}

/**
 * Docs-style direct formatting on top of the paragraph styles. Values are stored as
 * validated keys/numbers (they come from collaborators) and rendered to inline styles.
 */
export const TextFormat = Extension.create({
  name: "textFormat",

  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          // Each font overrides its custom property and re-declares the family, so the other
          // font is still inherited from the paragraph style (see FONT_FAMILY_FROM_VARS).
          latinFont: {
            default: null,
            parseHTML: (el) => (isLatinFontKey(el.dataset.latinFont) ? el.dataset.latinFont : null),
            renderHTML: (attrs) =>
              isLatinFontKey(attrs.latinFont)
                ? {
                    "data-latin-font": attrs.latinFont,
                    style: `--latin-font: ${LATIN_FONTS[attrs.latinFont].css}; font-family: ${FONT_FAMILY_FROM_VARS}`,
                  }
                : {},
          },
          koreanFont: {
            default: null,
            parseHTML: (el) => (isKoreanFontKey(el.dataset.koreanFont) ? el.dataset.koreanFont : null),
            renderHTML: (attrs) =>
              isKoreanFontKey(attrs.koreanFont)
                ? {
                    "data-korean-font": attrs.koreanFont,
                    style: `--korean-font: ${KOREAN_FONTS[attrs.koreanFont].css}; font-family: ${FONT_FAMILY_FROM_VARS}`,
                  }
                : {},
          },
          fontSize: {
            default: null,
            parseHTML: (el) => validSize(el.dataset.size),
            renderHTML: (attrs) => {
              const size = validSize(attrs.fontSize);
              return size ? { "data-size": size, style: `font-size: ${size}pt` } : {};
            },
          },
          color: {
            default: null,
            parseHTML: (el) => (isColor(el.dataset.color) ? el.dataset.color : null),
            renderHTML: (attrs) =>
              isColor(attrs.color) ? { "data-color": attrs.color, style: `color: ${attrs.color}` } : {},
          },
        },
      },
      {
        types: ALIGNABLE,
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (el) => (isTextAlign(el.style.textAlign) ? el.style.textAlign : null),
            renderHTML: (attrs) => (isTextAlign(attrs.textAlign) ? { style: `text-align: ${attrs.textAlign}` } : {}),
          },
        },
      },
    ];
  },

  addCommands() {
    const setStyleAttr =
      (name: string, value: unknown) =>
      ({ chain }: { chain: () => ChainedCommands }) =>
        value === null
          ? chain().setMark("textStyle", { [name]: null }).removeEmptyTextStyle().run()
          : chain().setMark("textStyle", { [name]: value }).run();

    return {
      setLatinFont: (font) => setStyleAttr("latinFont", isLatinFontKey(font) ? font : null),
      setKoreanFont: (font) => setStyleAttr("koreanFont", isKoreanFontKey(font) ? font : null),
      setFontSizePt: (size) => setStyleAttr("fontSize", validSize(size)),
      setTextColor: (color) => setStyleAttr("color", isColor(color) ? color : null),
      setBlockAlign:
        (align) =>
        ({ commands }) =>
          ALIGNABLE.map((type) => commands.updateAttributes(type, { textAlign: isTextAlign(align) ? align : null })).some(
            Boolean
          ),
      clearTextFormatting:
        () =>
        ({ tr, state, dispatch }) => {
          if (!dispatch) return true;
          const { from, to, empty } = tr.selection;
          if (empty) {
            tr.setStoredMarks(state.storedMarks?.filter((m) => KEEP_ON_CLEAR.has(m.type.name)) ?? []);
          } else {
            for (const type of Object.values(state.schema.marks)) {
              if (!KEEP_ON_CLEAR.has(type.name)) tr.removeMark(from, to, type);
            }
          }
          tr.doc.nodesBetween(from, to, (node, pos) => {
            if (ALIGNABLE.includes(node.type.name) && node.attrs.textAlign) {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: null });
            }
          });
          return true;
        },
    };
  },
});
