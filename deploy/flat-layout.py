"""Pure config checks; never print config contents or secret values."""
import copy
import json
import sys
from pathlib import Path


class ValidationFailure(ValueError):
    pass


def without_build(config):
    result = copy.deepcopy(config)
    for service in result.get("services", {}).values():
        service.pop("build", None)
    return result


def prepare(config):
    if config.get("name") != "trisoft-kan":
        raise ValidationFailure("Unexpected Compose project")
    if set(config.get("services", {})) != {"web", "postgres", "migrate"}:
        raise ValidationFailure("Unexpected Compose services")
    # JSON is valid YAML, and avoids needing PyYAML on the production host.
    return without_build(config)


def main():
    action = sys.argv[1]
    if action == "prepare":
        source, target = map(Path, sys.argv[2:4])
        target.write_text(json.dumps(prepare(json.loads(source.read_text())), indent=2) + "\n")
    elif action == "compare":
        old, new = (json.loads(Path(p).read_text()) for p in sys.argv[2:4])
        if without_build(old) != new:
            raise ValidationFailure("Rendered configurations differ beyond build sections; refusing switch")
    elif action == "runtime":
        config, runtime = (json.loads(Path(p).read_text()) for p in sys.argv[2:4])
        actual = dict(item.split("=", 1) for item in runtime)
        expected = config["services"]["web"].get("environment", {})
        if any(value is None or actual.get(key) != str(value) for key, value in expected.items()):
            raise ValidationFailure("Saved web settings differ from running container; resolve before relocation")
    else:
        raise ValidationFailure("Unknown action")


if __name__ == "__main__":
    try:
        main()
    except ValidationFailure as error:
        sys.exit(str(error))
    except Exception:
        # No exception repr/tracebacks: malformed config could contain secrets.
        sys.exit("Config validation failed; no secret values were printed.")
