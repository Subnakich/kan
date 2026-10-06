"""Keep the flat Compose configuration; change only images/obsolete transport."""
import json
import ipaddress
import sys
from pathlib import Path

OBSOLETE = {"TASK_CONTROL_GATEWAY_URL", "TASK_CONTROL_GATEWAY_TOKEN"}
INTEGRATION = {"TASK_CONTROL_ALLOWED_IPS", "TASK_CONTROL_SERVICE_TOKEN", "TASK_CONTROL_TRUSTED_PROXIES"}


def authorize(config, runtime, apply_integration=False, gateway=None):
    actual = dict(item.split("=", 1) for item in runtime)
    expected = config["services"]["web"].get("environment", {})
    different = {key for key, value in expected.items()
                 if value is None or actual.get(key) != str(value)}
    allowed = OBSOLETE | (INTEGRATION if apply_integration else set())
    unexpected = different - allowed
    if unexpected:
        names = sorted(key for key in unexpected if key.isidentifier())
        raise ValueError("Unapproved environment drift: " + ", ".join(names))
    if apply_integration:
        token = expected.get("TASK_CONTROL_SERVICE_TOKEN", "")
        if not isinstance(token, str) or len(token) < 32 or not all(33 <= ord(c) <= 126 for c in token):
            raise ValueError("TASK_CONTROL_SERVICE_TOKEN must contain at least 32 non-whitespace ASCII characters")
        for key, address in (("TASK_CONTROL_ALLOWED_IPS", "46.203.233.110"),
                             ("TASK_CONTROL_TRUSTED_PROXIES", gateway)):
            try:
                network = ipaddress.ip_network(expected.get(key, ""), strict=True)
                valid = network.num_addresses == 1 and network.network_address == ipaddress.ip_address(address)
            except (ValueError, TypeError):
                valid = False
            if not valid:
                raise ValueError(key + " must contain only the verified single host address")
    # Rollback must restore the actual OLD runtime, not newly edited .env values.
    rollback = json.loads(json.dumps(config))
    for key in list(rollback["services"]["web"]["environment"]):
        if key in actual:
            rollback["services"]["web"]["environment"][key] = actual[key]
        else:
            del rollback["services"]["web"]["environment"][key]
    return rollback


def prepare(config, release):
    if config.get("name") != "trisoft-kan":
        raise ValueError("Unexpected project")
    services = config.get("services", {})
    if set(services) != {"web", "migrate", "postgres"}:
        raise ValueError("Unexpected services")
    if services["web"].get("build") or services["migrate"].get("build"):
        raise ValueError("Expected flat image-only installation")
    services["web"]["image"] = f"trisoft-kan:{release}"
    services["migrate"]["image"] = f"trisoft-kan-migrate:{release}"
    environment = services["web"].get("environment", {})
    for key in ("TASK_CONTROL_GATEWAY_URL", "TASK_CONTROL_GATEWAY_TOKEN"):
        environment.pop(key, None)
    return config


if __name__ == "__main__":
    try:
        if sys.argv[1] == "authorize":
            source, runtime, target, mode, gateway = sys.argv[2:]
            result = authorize(json.loads(Path(source).read_text()), json.loads(Path(runtime).read_text()), mode == "apply", gateway)
        else:
            source, target, release = sys.argv[1:]
            result = prepare(json.loads(Path(source).read_text()), release)
        Path(target).write_text(json.dumps(result, indent=2) + "\n")
    except ValueError as error:
        # Controlled messages contain names/rules only, never config values.
        if isinstance(error, json.JSONDecodeError):
            sys.exit("Polling configuration JSON is invalid; values were not printed.")
        sys.exit(str(error))
    except Exception:
        sys.exit("Polling Compose validation failed; configuration was not printed.")
