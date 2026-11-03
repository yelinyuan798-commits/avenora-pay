export function csvCell(value) {
  let text = value == null ? "" : String(value).replace(/\0/g, "");
  // Quoting alone does not prevent spreadsheet formula execution.
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) {
    text = "'" + text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(headers, rows) {
  return (
    "\ufeff" +
    [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")
  );
}

export function downloadCsv(filename, headers, rows) {
  const url = URL.createObjectURL(
    new Blob([toCsv(headers, rows)], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
