import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

helper = Path(os.environ.get('INVITE_LAYOUT_HELPER', Path(__file__).parents[2] / 'deploy/invite-upgrade-layout.py'))
spec = importlib.util.spec_from_file_location('layout', helper)
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)

class LayoutTests(unittest.TestCase):
    def test_release_label_matches_installer(self):
        script = helper.with_name('invite-upgrade-root.sh').read_text()
        release = layout.IMAGE.removeprefix('trisoft-kan:')
        self.assertIn('RELEASE=' + release + '\n', script)
        self.assertIn('PREVIOUS=' + layout.PREVIOUS + '\n', script)

    def test_audit_failure_reports_log_before_any_switch(self):
        script = helper.with_name('invite-upgrade-root.sh').read_text()
        audit = script.index('if ! docker run --rm "trisoft-kan:$RELEASE"')
        failure = script.index('Runtime image audit failed; inspect $BACKUP/image-audit.log')
        switch = script.index('SWITCHED=true')
        self.assertLess(audit, failure)
        self.assertLess(failure, switch)
        self.assertIn('Working Kan has not been switched.', script)

    def config(self):
        return {'name': 'trisoft-kan', 'services': {
            'web': {'image': layout.PREVIOUS, 'environment': {
                'NEXT_PUBLIC_BASE_URL': 'https://kanban.trisoft.ru',
                'NEXT_PUBLIC_ALLOW_CREDENTIALS': 'true',
                'NEXT_PUBLIC_DISABLE_SIGN_UP': 'true',
                'NEXT_PUBLIC_DISABLE_EMAIL': 'true',
                'NEXT_PUBLIC_KAN_ENV': 'self-hosted',
                'TASK_CONTROL_SERVICE_TOKEN': '${TASK_CONTROL_SERVICE_TOKEN}',
                'TASK_CONTROL_ALLOWED_IPS': '${TASK_CONTROL_ALLOWED_IPS}',
            }},
            'migrate': {'image': 'old-migrator'},
            'postgres': {'image': 'postgres:15-alpine', 'volumes': ['postgres:/var/lib/postgresql/data']},
        }, 'volumes': {'postgres': {'name': 'trisoft-kan_postgres'}}}

    def test_only_web_image_changes_and_input_is_not_mutated(self):
        before = self.config()
        original = copy.deepcopy(before)
        after = layout.prepare(before)
        expected = copy.deepcopy(before)
        expected['services']['web']['image'] = layout.IMAGE
        self.assertEqual(after, expected)
        self.assertEqual(before, original)
        layout.compare(before, after)

    def test_unexpanded_env_is_kept_verbatim(self):
        before = self.config()
        before['services']['web']['environment']['NEXT_PUBLIC_DISABLE_SIGN_UP'] = '${NEXT_PUBLIC_DISABLE_SIGN_UP:-true}'
        after = layout.prepare(before)
        self.assertEqual(after['services']['web']['environment'], before['services']['web']['environment'])

    def test_unexpected_project_services_build_or_image_are_rejected(self):
        for mutate in [lambda c: c.update(name='redmine'),
                       lambda c: c['services'].update(extra={}),
                       lambda c: c['services']['web'].update(build='.'),
                       lambda c: c['services']['web'].update(image='unexpected')]:
            config = self.config()
            mutate(config)
            with self.assertRaises(ValueError): layout.prepare(config)

    def test_db_env_port_and_proxy_drift_are_rejected(self):
        for mutate in [lambda c: c['services']['postgres'].update(image='postgres:16'),
                       lambda c: c['services']['web']['environment'].update(TASK_CONTROL_SERVICE_TOKEN='SECRET-FIXTURE'),
                       lambda c: c['services']['web'].update(ports=['3100:3000']),
                       lambda c: c['services']['migrate'].update(image='new-migrator')]:
            before = self.config()
            after = layout.prepare(before)
            mutate(after)
            with self.assertRaises(ValueError) as error: layout.compare(before, after)
            self.assertNotIn('SECRET-FIXTURE', str(error.exception))

    def test_public_signup_or_instance_drift_are_rejected(self):
        for key in ['NEXT_PUBLIC_DISABLE_SIGN_UP', 'NEXT_PUBLIC_DISABLE_EMAIL', 'NEXT_PUBLIC_ALLOW_CREDENTIALS', 'NEXT_PUBLIC_BASE_URL']:
            before = self.config()
            before['services']['web']['environment'][key] = 'SECRET-FIXTURE'
            after = layout.prepare(before)
            with self.assertRaises(ValueError) as error: layout.compare(before, after)
            self.assertNotIn('SECRET-FIXTURE', str(error.exception))

    def test_invalid_json_does_not_print_config_values(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'source.json'
            source.write_text('{"secret": "SECRET-FIXTURE", invalid}')
            run = subprocess.run([sys.executable, str(helper), 'prepare', str(source), str(Path(folder) / 'out.json')], capture_output=True, text=True)
            self.assertNotEqual(run.returncode, 0)
            self.assertNotIn('SECRET-FIXTURE', run.stdout + run.stderr)

if __name__ == '__main__': unittest.main()
