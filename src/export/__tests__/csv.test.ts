import { describe, it, expect } from "vitest";
import { CSV_BOM, csvEscape, csvHeader, csvRow, getPath, inferColumns } from "../csv.js";

describe("csvEscape formula guard", () => {
  it.each([
    ["=SUM(A1)", "'=SUM(A1)"],
    ["+1 555 0100", "'+1 555 0100"],
    ["@cmd", "'@cmd"],
    ["-1+2", "'-1+2"],
    ["-cmd|' /C calc'!A0", "'-cmd|' /C calc'!A0"],
    ["\tTabbed", "'\tTabbed"],
  ])("prefixes the text value %j", (input, expected) => {
    expect(csvEscape(input)).toBe(expected);
  });

  it("never touches numbers, including negative amounts", () => {
    expect(csvEscape(-12.5)).toBe("-12.5");
    expect(csvEscape(0)).toBe("0");
    expect(csvEscape(1500)).toBe("1500");
  });

  it("leaves plain decimal strings alone so negative amounts sent as text stay numeric in Excel", () => {
    expect(csvEscape("-12.50")).toBe("-12.50");
    expect(csvEscape("+5")).toBe("+5");
    expect(csvEscape("42")).toBe("42");
  });

  it("leaves ordinary text, empty values and booleans alone", () => {
    expect(csvEscape("Plain text")).toBe("Plain text");
    expect(csvEscape(" leading space")).toBe(" leading space");
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
    expect(csvEscape(true)).toBe("true");
  });

  it("quotes values with commas, quotes or line breaks and doubles inner quotes", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  it("writes nested values as JSON without guarding them", () => {
    expect(csvEscape([{ a: 1 }])).toBe('"[{""a"":1}]"');
    expect(csvEscape({ a: "=x" })).toBe('"{""a"":""=x""}"');
  });
});

describe("csv rows", () => {
  it("starts with a byte order mark and ends rows with CRLF", () => {
    expect(csvHeader(["id", "name"])).toBe(`${CSV_BOM}id,name\r\n`);
    expect(csvRow({ id: 1, name: "x" }, ["id", "name"])).toBe("1,x\r\n");
  });

  it("reads dotted paths and tolerates missing parents", () => {
    const row = { client: { name: "A" }, matter: null };
    expect(getPath(row, "client.name")).toBe("A");
    expect(getPath(row, "matter.id")).toBeUndefined();
    expect(csvRow(row, ["client.name", "matter.id", "missing"])).toBe("A,,\r\n");
  });

  it("infers columns from the first page with id first", () => {
    expect(inferColumns([{ name: "x", id: 1 }, { zeta: 1 }])).toEqual(["id", "name", "zeta"]);
  });
});
