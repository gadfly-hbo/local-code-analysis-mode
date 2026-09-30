"""F01 reader unit tests: CSV/XLSX/Parquet parity + pathological rejections."""

import duckdb
import pytest
from openpyxl import Workbook

from worker.readers import FormatError, read_any, sniff


def write_xlsx(path, rows, merged=None):
    book = Workbook()
    sheet = book.active
    for row in rows:
        sheet.append(row)
    if merged:
        sheet.merge_cells(merged)
    book.save(path)


def test_same_data_across_three_formats_yields_identical_frames(tmp_path):
    rows = [("order_id", "amount"), ("007", "100.5"), ("008", "200")]
    csv_path = tmp_path / "s.csv"
    csv_path.write_text("\n".join(",".join(r) for r in rows) + "\n", encoding="utf-8")
    write_xlsx(tmp_path / "s.xlsx", rows)

    con = duckdb.connect(":memory:")
    con.execute(
        "COPY (SELECT * FROM (VALUES ('007', 100.5), ('008', 200)) AS t(order_id, amount)) "
        f"TO '{tmp_path / 's.parquet'}' (FORMAT PARQUET)"
    )

    frames = [read_any(str(p)) for p in (csv_path, tmp_path / "s.xlsx", tmp_path / "s.parquet")]
    # Identifier columns stay string-identical across formats (leading zeros kept).
    for frame in frames[1:]:
        assert list(frame["order_id"]) == list(frames[0]["order_id"])
        assert list(frame.columns) == list(frames[0].columns)
    # Numeric columns: xlsx/parquet carry typed numbers (200 → "200"/"200.0" per
    # format); analysis-level parity is what matters (astype(float) equality).
    for frame in frames[1:]:
        assert [float(v) for v in frame["amount"]] == [float(v) for v in frames[0]["amount"]]


def test_pathological_xlsx_rejected_with_clear_errors(tmp_path):
    empty_header = tmp_path / "empty_header.xlsx"
    write_xlsx(empty_header, [(None, None), ("007", "100")])
    with pytest.raises(FormatError, match=r"empty( header row|/missing header cells)"):
        read_any(str(empty_header))

    dup_cols = tmp_path / "dup.xlsx"
    write_xlsx(dup_cols, [("a", "a"), ("1", "2")])
    with pytest.raises(FormatError, match="duplicate column"):
        read_any(str(dup_cols))

    merged = tmp_path / "merged.xlsx"
    write_xlsx(merged, [("cat", "v"), ("womens", 1), ("mens", 2)], merged="A2:A3")
    with pytest.raises(FormatError, match="merged cells"):
        read_any(str(merged))


def test_nested_parquet_rejected_and_sniff_reports_sheets(tmp_path):
    nested = tmp_path / "nested.parquet"
    con = duckdb.connect(":memory:")
    con.execute(
        f"COPY (SELECT [1, 2, 3] AS lst) TO '{nested}' (FORMAT PARQUET)"
    )
    with pytest.raises(FormatError, match="nested columns.*lst"):
        read_any(str(nested))

    multi = tmp_path / "multi.xlsx"
    write_xlsx(multi, [("a",), ("1",)])
    from openpyxl import load_workbook

    book = load_workbook(multi)
    book.create_sheet("sheet2")
    book.save(multi)
    info = sniff(str(multi))
    assert info["sheet_names"] == ["Sheet", "sheet2"]
    assert "multiple sheets" in info["note"]
    assert info["rows"] == 1

    with pytest.raises(FormatError, match="unsupported extension"):
        read_any(str(tmp_path / "x.zip"))
