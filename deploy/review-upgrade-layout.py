"""Change only the Kan web image; never emit environment values."""
import copy
import json
import sys
from pathlib import Path

PREVIOUS = "trisoft-kan:20261006-task-control-4-polling"
ALLOWED_PREVIOUS = {PREVIOUS, "trisoft-kan:20261007-invite-link-2"}
IMAGE = "trisoft-kan:20261007-review-1"


def prepare(config):
    if config.get("name") != "trisoft-kan":
        raise ValueError("Unexpected Compose project")
    services = config.get("services", {})
    if set(services) != {"web", "postgres", "migrate"}:
        raise ValueError("Unexpected Compose services")
    if any(service.get("build") for service in services.values()):
        raise ValueError("Expected image-only flat installation")
    if services["web"].get("image") not in ALLOWED_PREVIOUS:
        raise ValueError("Expected verified polling-4 or invite-link-2 web image")
    result = copy.deepcopy(config)
    result["services"]["web"]["image"] = IMAGE
    return result


def validate_settings(config):
    services = config["services"]
    expected = {
        "NEXT_PUBLIC_BASE_URL": "https://kanban.trisoft.ru",
        "NEXT_PUBLIC_ALLOW_CREDENTIALS": "true",
        "NEXT_PUBLIC_DISABLE_SIGN_UP": "true",
        "NEXT_PUBLIC_DISABLE_EMAIL": "true",
        "NEXT_PUBLIC_KAN_ENV": "self-hosted",
    }
    environment = services["web"].get("environment", {})
    if any(environment.get(key) != value for key, value in expected.items()):
        raise ValueError("Unexpected registration or instance settings")


def compare(before, after):
    validate_settings(before)
    expected = copy.deepcopy(before)
    expected["services"]["web"]["image"] = IMAGE
    if expected != after:
        raise ValueError("Configuration drift beyond Kan web image")


if __name__ == "__main__":
    try:
        action, source, target = sys.argv[1:]
        before = json.loads(Path(source).read_text())
        if action == "prepare":
            Path(target).write_text(json.dumps(prepare(before), indent=2) + "\n")
        elif action == "compare":
            compare(before, json.loads(Path(target).read_text()))
        else:
            raise ValueError("Unknown action")
    except ValueError as error:
        if isinstance(error, json.JSONDecodeError):
            sys.exit("Invalid configuration JSON; values were not printed")
        sys.exit(str(error))
    except Exception:
        sys.exit("Review upgrade validation failed; values were not printed")
