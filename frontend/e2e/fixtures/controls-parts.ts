import {createAnnouncementPart, createButtonPart, createCopyButtonPart, createStackPart, mountParts} from 'pith-ui';
import 'pith-ui/styles.css';

interface Availability {disabled?: boolean;pending?: boolean}
interface ControlsRegression {
  actionSnapshot(state: Availability): void;
  copySnapshot(state: Availability): void;
  resolveAction(): void;
  resolveCopy(): void;
  counts(): {actions: number;copies: number};
}
declare global {interface Window {controlsRegression: ControlsRegression}}

let actions = 0,copies = 0;
let resolveAction: (() => void) | undefined,resolveCopy: (() => void) | undefined;
const announcement = createAnnouncementPart({message: ''});
const action = createButtonPart({label: 'Run action',onAction() {actions++;return new Promise<void>(resolve => {resolveAction = resolve;});}});
const copy = createCopyButtonPart({label: 'Copy result',announcement,successMessage: 'Result copied.',onCopy() {copies++;return new Promise<void>(resolve => {resolveCopy = resolve;});}});
const mount = document.getElementById('parts-regression');
if (!(mount instanceof HTMLDivElement)) throw new Error('The controls regression mount is missing.');
mountParts(mount,createStackPart({children: [action,copy,announcement]}),{appearance: 'light'});
window.controlsRegression = {
  actionSnapshot(state) {action.update({label: 'Run action',...state});},
  copySnapshot(state) {copy.update({label: 'Copy result',...state});},
  resolveAction() {if (!resolveAction) throw new Error('No action is pending.');const done = resolveAction;resolveAction = undefined;done();},
  resolveCopy() {if (!resolveCopy) throw new Error('No copy is pending.');const done = resolveCopy;resolveCopy = undefined;done();},
  counts() {return {actions,copies};},
};
