"""Golden-test runner (Python original): executes scripts/golden_cases.json
against the Python package and writes canonical results to stdout as JSON."""
import importlib
import json
import sys

sys.path.insert(0, "/home/hatch/workspace/mcp-pt-inspect/src")


def build(value, spec):
    if isinstance(value, dict) and "$model" in value:
        mod_path, cls_name = value["$model"].split(":")
        cls = getattr(importlib.import_module("packet_tracer_mcp." + mod_path), cls_name)
        fields = {k: build(v, spec) for k, v in value["fields"].items()}
        return cls(**fields)
    if isinstance(value, dict):
        return {k: build(v, spec) for k, v in value.items()}
    if isinstance(value, list):
        return [build(v, spec) for v in value]
    if isinstance(value, str) and value.startswith("$") and value[1:] in spec:
        return build(spec[value[1:]], spec)
    return value


def canon(result):
    if isinstance(result, str):
        return {"kind": "str", "value": result}
    if hasattr(result, "model_dump"):
        result = result.model_dump(mode="json")
    return {"kind": "json", "value": json.dumps(result, ensure_ascii=False, default=str)}


def main():
    spec = json.load(open("/home/hatch/workspace/packet-tracer-mcp-node/scripts/golden_cases.json"))
    out = {}
    for case in spec["cases"]:
        cid = case["id"]
        try:
            mod = importlib.import_module("packet_tracer_mcp." + case["module"])
            if "const" in case:
                out[cid] = canon(getattr(mod, case["const"]))
            else:
                fn = getattr(mod, case["fn"])
                args = [build(a, spec) for a in case.get("args", [])]
                kwargs = {k: build(v, spec) for k, v in case.get("kwargs", {}).items()}
                out[cid] = canon(fn(*args, **kwargs))
        except Exception as e:  # noqa: BLE001 - the class of failure is the data
            out[cid] = {"kind": "error", "value": f"{type(e).__name__}: {e}"}
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
