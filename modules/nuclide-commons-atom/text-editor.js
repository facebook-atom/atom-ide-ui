/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @format
 */

import type {NuclideUri} from 'nuclide-commons/nuclideUri';

import invariant from 'assert';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import {Observable} from 'rxjs';
import semver from 'semver';

import {observableFromSubscribeFunction} from 'nuclide-commons/event';

/**
 * Returns a text editor that has the given path open, or null if none exists. If there are multiple
 * text editors for this path, one is chosen arbitrarily.
 */
export function existingEditorForUri(path: NuclideUri): ?atom$TextEditor {
  // This isn't ideal but realistically iterating through even a few hundred editors shouldn't be a
  // real problem. And if you have more than a few hundred you probably have bigger problems.
  for (const editor of atom.workspace.getTextEditors()) {
    if (editor.getPath() === path) {
      return editor;
    }
  }

  return null;
}

/**
 * Returns a text editor that has the given buffer open, or null if none exists. If there are
 * multiple text editors for this buffer, one is chosen arbitrarily.
 */
export function existingEditorForBuffer(
  buffer: atom$TextBuffer,
): ?atom$TextEditor {
  // This isn't ideal but realistically iterating through even a few hundred editors shouldn't be a
  // real problem. And if you have more than a few hundred you probably have bigger problems.
  for (const editor of atom.workspace.getTextEditors()) {
    if (editor.getBuffer() === buffer) {
      return editor;
    }
  }

  return null;
}

export function getViewOfEditor(
  editor: atom$TextEditor,
): atom$TextEditorElement {
  return atom.views.getView(editor);
}

export function getScrollTop(editor: atom$TextEditor): number {
  return getViewOfEditor(editor).getScrollTop();
}

export function setScrollTop(editor: atom$TextEditor, scrollTop: number): void {
  getViewOfEditor(editor).setScrollTop(scrollTop);
}

/**
 * Does a best effort to set an editor pane to a given cursor position & scroll.
 * Does not ensure that the current cursor position is visible.
 *
 * Can be used with editor.getCursorBufferPosition() & getScrollTop() to restore
 * an editors cursor and scroll.
 */
export function setPositionAndScroll(
  editor: atom$TextEditor,
  position: atom$Point,
  scrollTop: number,
): void {
  editor.setCursorBufferPosition(position, {autoscroll: false});
  setScrollTop(editor, scrollTop);
}

export function getCursorPositions(
  editor: atom$TextEditor,
): Observable<atom$Point> {
  return Observable.defer(() => {
    // This will behave strangely in the face of multiple cursors. Consider supporting multiple
    // cursors in the future.
    const cursor = editor.getCursors()[0];
    invariant(cursor != null);
    return Observable.merge(
      Observable.of(cursor.getBufferPosition()),
      observableFromSubscribeFunction(
        cursor.onDidChangePosition.bind(cursor),
      ).map(event => event.newBufferPosition),
    );
  });
}

export function observeEditorDestroy(
  editor: atom$TextEditor,
): Observable<atom$TextEditor> {
  return observableFromSubscribeFunction(editor.onDidDestroy.bind(editor))
    .map(event => editor)
    .take(1);
}

// As of the introduction of atom.workspace.buildTextEditor(), it is no longer possible to
// subclass TextEditor to create a ReadOnlyTextEditor. Instead, the way to achieve this effect
// is to create an ordinary TextEditor and then override any methods that would allow it to
// change its contents.
// TODO: https://github.com/atom/atom/issues/9237.
export function enforceReadOnlyEditor(
  textEditor: atom$TextEditor,
  readOnlyExceptions?: Array<string> = ['append', 'setText'],
): IDisposable {
  // Cancel insert events to prevent typing in the text editor and disallow editing (read-only).
  const willInsertTextDisposable = textEditor.onWillInsertText(event => {
    event.cancel();
  });

  return new UniversalDisposable(
    willInsertTextDisposable,
    // `setText` & `append` are the only exceptions that's used to set the read-only text.
    enforceReadOnlyBuffer(textEditor.getBuffer(), readOnlyExceptions),
  );
}

function enforceReadOnlyBuffer(
  textBuffer: atom$TextBuffer,
  readOnlyExceptions?: Array<string> = [],
): IDisposable {
  const noop = () => {};
  // All user edits use `transact` - so, mocking this will effectively make the editor read-only.
  const originalApplyChange = textBuffer.applyChange;
  const originalReadOnlyExceptionFunctions = {};
  textBuffer.applyChange = noop;

  readOnlyExceptions.forEach(passReadOnlyException);

  function passReadOnlyException(functionName: string) {
    const buffer: any = textBuffer;
    const originalFunction = buffer[functionName];
    originalReadOnlyExceptionFunctions[functionName] = originalFunction;

    buffer[functionName] = function() {
      textBuffer.applyChange = originalApplyChange;
      const result = originalFunction.apply(textBuffer, arguments);
      textBuffer.applyChange = noop;
      return result;
    };
  }

  return new UniversalDisposable(() => {
    textBuffer.applyChange = originalApplyChange;

    const buffer: any = textBuffer;
    readOnlyExceptions.forEach(
      functionName =>
        (buffer[functionName] =
          originalReadOnlyExceptionFunctions[functionName]),
    );
  });
}

// Turn off soft wrap setting for these editors so diffs properly align.
// Some text editor register sometimes override the set soft wrapping
// after mounting an editor to the workspace - here, that's watched and reset to `false`.
export function enforceSoftWrap(
  editor: atom$TextEditor,
  enforcedSoftWrap: boolean,
): IDisposable {
  editor.setSoftWrapped(enforcedSoftWrap);
  return editor.onDidChangeSoftWrapped(softWrapped => {
    if (softWrapped !== enforcedSoftWrap) {
      // Reset the overridden softWrap to `false` once the operation completes.
      process.nextTick(() => {
        if (!editor.isDestroyed()) {
          editor.setSoftWrapped(enforcedSoftWrap);
        }
      });
    }
  });
}

/**
 * Checks if an object (typically an Atom pane) is a TextEditor.
 */
export function isValidTextEditor(item: mixed): boolean {
  return atom.workspace.isTextEditor(item);
}

export function centerScrollToBufferLine(
  textEditorElement: atom$TextEditorElement,
  bufferLineNumber: number,
): void {
  const textEditor = textEditorElement.getModel();
  const pixelPositionTop = textEditorElement.pixelPositionForBufferPosition([
    bufferLineNumber,
    0,
  ]).top;
  // Manually calculate the scroll location, instead of using
  // `textEditor.scrollToBufferPosition([lineNumber, 0], {center: true})`
  // because that API to wouldn't center the line if it was in the visible screen range.
  const scrollTop =
    pixelPositionTop +
    textEditor.getLineHeightInPixels() / 2 -
    textEditorElement.clientHeight / 2;
  textEditorElement.setScrollTop(Math.max(scrollTop, 1));

  textEditorElement.focus();

  textEditor.setCursorBufferPosition([bufferLineNumber, 0], {
    autoscroll: false,
  });
}

export function getNonWordCharacters(
  editor: atom$TextEditor,
  position?: atom$PointLike,
): string {
  if (semver.gte(atom.getVersion(), '1.24.0-beta0')) {
    return editor.getNonWordCharacters(position);
  } else {
    // This used to take a scope descriptor.
    const scope =
      position == null
        ? null
        : editor.scopeDescriptorForBufferPosition(position);
    return editor.getNonWordCharacters((scope: any));
  }
}
