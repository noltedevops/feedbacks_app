from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

import yaml

VALID_IDENTIFIER = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
COMMON_SRIDS = {25832, 25833, 31466, 31467, 31468, 31469, 4326, 3857, 4258, 3034, 3035}


def validate_column_spec(col_name: str, spec: Any, errors: list[str], ctx: str) -> None:
    if spec is None:
        if col_name in ("easting", "northing"):
            errors.append(f"{ctx}: '{col_name}' cannot be null")
        return
    if isinstance(spec, str):
        if not spec.strip():
            errors.append(f"{ctx}: '{col_name}' string value cannot be empty")
        return
    if isinstance(spec, dict):
        if "expr" in spec:
            if not isinstance(spec["expr"], str) or not spec["expr"].strip():
                errors.append(f"{ctx}: '{col_name}.expr' must be a non-empty SQL string")
            return
        if "column" in spec:
            if not isinstance(spec["column"], str) or not spec["column"].strip():
                errors.append(f"{ctx}: '{col_name}.column' must be a non-empty column name")
            if "round" in spec and not isinstance(spec["round"], int):
                errors.append(f"{ctx}: '{col_name}.round' must be an integer")
            if "fallback" in spec:
                fb = spec["fallback"]
                if not isinstance(fb, dict):
                    errors.append(f"{ctx}: '{col_name}.fallback' must be a dictionary")
                else:
                    if fb.get("rule") != "trailing_number":
                        errors.append(f"{ctx}: unknown fallback rule '{fb.get('rule')}'; expected 'trailing_number'")
                    if not fb.get("column"):
                        errors.append(f"{ctx}: fallback rule requires 'column'")
            return
    errors.append(f"{ctx}: invalid spec for '{col_name}': {spec!r}")


def validate_config_data(cfg: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    if not isinstance(cfg, dict):
        return ["Configuration root must be a YAML mapping/dictionary"]

    if "projects" not in cfg:
        return ["Missing required top-level key: 'projects'"]

    if not isinstance(cfg["projects"], list) or not cfg["projects"]:
        return ["'projects' must be a non-empty list of project definitions"]

    if "correction_radius_m" in cfg:
        radius = cfg["correction_radius_m"]
        if not isinstance(radius, (int, float)) or radius <= 0:
            errors.append(f"'correction_radius_m' must be a positive number; got {radius!r}")

    seen_project_ids: set[str] = set()

    for idx, p in enumerate(cfg["projects"]):
        ctx = f"Project #{idx + 1}"
        if not isinstance(p, dict):
            errors.append(f"{ctx} must be a dictionary")
            continue

        pid = p.get("project_id")
        if not pid or not isinstance(pid, str):
            errors.append(f"{ctx}: 'project_id' must be a non-empty string")
        elif pid in seen_project_ids:
            errors.append(f"{ctx}: duplicate project_id '{pid}'")
        else:
            seen_project_ids.add(pid)
            ctx = f"Project '{pid}'"

        pname = p.get("project_name")
        if not pname or not isinstance(pname, str):
            errors.append(f"{ctx}: 'project_name' must be a non-empty string")

        schema = p.get("schema")
        if not schema or not isinstance(schema, str):
            errors.append(f"{ctx}: 'schema' must be a non-empty string")
        elif not VALID_IDENTIFIER.match(schema):
            errors.append(f"{ctx}: schema '{schema}' is not a valid PostgreSQL identifier")

        srid = p.get("srid")
        if not isinstance(srid, int) or srid <= 0:
            errors.append(f"{ctx}: 'srid' must be a positive integer EPSG code (e.g. 25832)")
        elif srid not in COMMON_SRIDS:
            # Not fatal error, but worth validating
            pass

        vm_prefix = p.get("vm_prefix")
        if not vm_prefix or not isinstance(str(vm_prefix), str):
            errors.append(f"{ctx}: 'vm_prefix' must be provided")

        sources = p.get("sources")
        if not isinstance(sources, list) or not sources:
            errors.append(f"{ctx}: 'sources' must be a non-empty list of source tables")
            continue

        seen_tables: set[str] = set()
        for s_idx, s in enumerate(sources):
            s_ctx = f"{ctx} -> source #{s_idx + 1}"
            if not isinstance(s, dict):
                errors.append(f"{s_ctx} must be a dictionary")
                continue

            tbl = s.get("table")
            if not tbl or not isinstance(tbl, str):
                errors.append(f"{s_ctx}: 'table' must be a non-empty string")
            elif tbl in seen_tables:
                errors.append(f"{ctx}: duplicate source table '{tbl}'")
            else:
                seen_tables.add(tbl)
                s_ctx = f"{ctx} -> source '{tbl}'"

            instrument = s.get("instrument")
            if not instrument or not isinstance(instrument, str):
                errors.append(f"{s_ctx}: 'instrument' must be a non-empty string")

            id_decimals = s.get("id_decimals")
            if id_decimals is None or not isinstance(id_decimals, int) or id_decimals < 0:
                errors.append(f"{s_ctx}: 'id_decimals' must be a non-negative integer (e.g. 3)")

            if "coord_round" in s and (not isinstance(s["coord_round"], int) or s["coord_round"] < 0):
                errors.append(f"{s_ctx}: 'coord_round' must be a non-negative integer")

            cols = s.get("columns")
            if not isinstance(cols, dict):
                errors.append(f"{s_ctx}: 'columns' must be a mapping of column definitions")
            else:
                for req_col in ("easting", "northing", "category"):
                    if req_col not in cols:
                        errors.append(f"{s_ctx}: 'columns' is missing required coordinate '{req_col}'")
                for col_name, spec in cols.items():
                    validate_column_spec(col_name, spec, errors, s_ctx)

            if "id_columns" in s:
                idc = s["id_columns"]
                if not isinstance(idc, dict) or "easting" not in idc or "northing" not in idc:
                    errors.append(f"{s_ctx}: 'id_columns' must be a mapping with 'easting' and 'northing'")

    return errors


def validate_config_file(path: Path | str) -> list[str]:
    path = Path(path)
    if not path.is_file():
        return [f"Configuration file not found: {path}"]
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as e:
        return [f"YAML syntax error in {path}: {e}"]
    return validate_config_data(data)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate ETL projects.yml configuration file")
    parser.add_argument("path", nargs="?", default="etl/config/projects.yml", help="Path to projects.yml")
    args = parser.parse_args()

    config_path = Path(args.path)
    print(f"Validating ETL configuration: {config_path} ...")
    errors = validate_config_file(config_path)
    if errors:
        print(f"FAILED: Found {len(errors)} configuration error(s):")
        for err in errors:
            print(f"  [!] {err}")
        return 1
    print("SUCCESS: Configuration is valid and adheres to all schema rules.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
