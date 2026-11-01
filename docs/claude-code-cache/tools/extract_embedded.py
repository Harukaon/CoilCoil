#!/usr/bin/env python3
"""Extract readable Bun JS from a local Claude executable, without executing it.

This is a source-string extractor, not a native-code or bytecode decompiler.
The module-table mapping is validated against each source's offset and length.
Tested against the darwin-arm64 Claude Code 2.1.302 distribution.
"""

import argparse
import hashlib
import json
import mmap
import re
import struct
from pathlib import Path


def bun_section(binary):
    if len(binary) < 32:
        raise ValueError("Truncated Mach-O header")
    if struct.unpack_from("<I", binary)[0] != 0xFEEDFACF:
        raise ValueError("Expected a little-endian 64-bit Mach-O executable")
    ncmds, sizeofcmds = struct.unpack_from("<II", binary, 16)
    commands_end = 32 + sizeofcmds
    if commands_end > len(binary) or ncmds > sizeofcmds // 8:
        raise ValueError("Invalid Mach-O command region")
    cursor = 32
    result = None
    for _ in range(ncmds):
        if cursor + 8 > commands_end:
            raise ValueError("Truncated Mach-O load command")
        cmd, size = struct.unpack_from("<II", binary, cursor)
        if size < 8 or cursor + size > commands_end:
            raise ValueError("Invalid Mach-O load command")
        if cmd == 0x19:  # LC_SEGMENT_64
            if size < 72:
                raise ValueError("Truncated LC_SEGMENT_64")
            sections = struct.unpack_from("<I", binary, cursor + 64)[0]
            if 72 + 80 * sections > size:
                raise ValueError("Section table extends past load command")
            for index in range(sections):
                section = cursor + 72 + 80 * index
                name = binary[section:section + 16].split(b"\0")[0]
                if name == b"__bun":
                    length = struct.unpack_from("<Q", binary, section + 40)[0]
                    offset = struct.unpack_from("<I", binary, section + 48)[0]
                    if length < 8 or offset + length > len(binary):
                        raise ValueError("Invalid __bun section bounds")
                    if result is not None:
                        raise ValueError("Ambiguous __bun sections")
                    result = offset, length
        cursor += size
    if cursor != commands_end:
        raise ValueError("Mach-O load command sizes do not match sizeofcmds")
    if result is None:
        raise ValueError("No __bun section found")
    return result


def extract(binary_path, output):
    output.mkdir(parents=True, exist_ok=True)
    raw = output / "raw"
    raw.mkdir(exist_ok=True)
    with binary_path.open("rb") as handle:
        binary = mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
        section_offset, section_length = bun_section(binary)
        section_end = section_offset + section_length
        base = section_offset + 8
        records = []
        pattern = rb"(?:^|\x00)(// @bun @bytecode\n)"
        for match in re.compile(pattern).finditer(binary, section_offset, section_end):
            start = match.start(1)
            if not section_offset <= start < section_end:
                continue
            end = binary.find(b"\0", start, section_end)
            if end == -1:
                raise ValueError(f"Unterminated source at {start}")
            source = binary[start:end]
            filename = f"{start:012d}.js"
            (raw / filename).write_bytes(source)
            records.append({"file": filename, "offset": start,
                            "length": len(source),
                            "sha256": hashlib.sha256(source).hexdigest()})
        if not records:
            raise ValueError("No readable // @bun @bytecode sources found")

        # Bun stores path/source pairs as u32 offset+length references.
        # Locate the first source's table entry, then validate all mappings.
        first = records[0]
        reference = struct.pack("<II", first["offset"] - base, first["length"])
        table_start = binary.rfind(reference, base, section_end)
        if table_start != -1:
            table_start -= 8
            for record in records:
                reference = struct.pack("<II", record["offset"] - base,
                                        record["length"])
                at = binary.find(reference, table_start, section_end)
                if at < 8 or (at - 8 - table_start) % 52:
                    continue
                path_offset, path_length = struct.unpack_from("<II", binary, at - 8)
                absolute = base + path_offset
                if not (0 < path_length <= 4096 and base <= absolute and
                        absolute + path_length <= section_end):
                    continue
                path = binary[absolute:absolute + path_length].rstrip(b"\0")
                if path.startswith(b"/$bunfs/root/"):
                    record["module"] = path.decode("utf-8")

        modules = [r.get("module") for r in records]
        if None in modules or len(set(modules)) != len(records):
            raise ValueError("Incomplete/duplicate Bun module mapping; format may have changed")

        version_match = re.search(rb"// Version: ([^\n]+)",
                                  (raw / first["file"]).read_bytes())
        manifest = {"binary": str(binary_path.resolve()),
                    "sha256": hashlib.sha256(binary).hexdigest(),
                    "size": len(binary),
                    "version": version_match[1].decode() if version_match else None,
                    "bun_section_offset": section_offset,
                    "bun_section_length": section_length,
                    "bun_data_base": base,
                    "sources": records}
        (output / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        (output / "module-map.json").write_text(json.dumps(
            {r["module"]: r["file"] for r in records if "module" in r}, indent=2) + "\n")
        print(json.dumps({"version": manifest["version"],
                          "sha256": manifest["sha256"], "sources": len(records),
                          "mapped": sum("module" in r for r in records),
                          "source_bytes": sum(r["length"] for r in records),
                          "output": str(output.resolve())}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    extract(args.binary, args.output)
