/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

import type {NuclideUri} from 'nuclide-commons/nuclideUri';
import type {GeneratedFileType} from '../nuclide-generated-files-rpc';
import type {FileChangeStatusValue} from '../nuclide-vcs-base';
import {
  addPath,
  confirmAndRevertPath,
  confirmAndDeletePath,
  forgetPath,
  FileChangeStatus,
  RevertibleStatusCodes,
} from '../nuclide-vcs-base';
import {goToLocation} from 'nuclide-commons-atom/go-to-location';
import {openFileInDiffView} from '../commons-atom/open-in-diff-view';
import {track} from '../nuclide-analytics';
import invariant from 'assert';
import nuclideUri from 'nuclide-commons/nuclideUri';
import * as React from 'react';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import ChangedFilesList from './ChangedFilesList';
import {TreeList, TreeItem} from 'nuclide-commons-ui/Tree';
import Immutable from 'immutable';
import classnames from 'classnames';

type Props = {
  // Used to identify which surface (e.g. file tree vs SCM side bar) was used to trigger an action.
  analyticsSurface?: string,
  // List of files that have checked checkboxes next to their names. `null` -> no checkboxes
  checkedFiles: ?Map<NuclideUri, Set<NuclideUri>>,
  enableInlineActions?: true,
  fileStatuses: Map<NuclideUri, Map<NuclideUri, FileChangeStatusValue>>,
  generatedTypes?: Immutable.Map<NuclideUri, GeneratedFileType>,
  commandPrefix: string,
  selectedFile: ?NuclideUri,
  hideEmptyFolders?: boolean,
  // Callback when a file's checkbox is toggled
  onFileChecked?: (filePath: NuclideUri) => mixed,
  onFileChosen: (filePath: NuclideUri) => mixed,
  onMarkFileResolved?: (filePath: NuclideUri) => mixed,
  getRevertTargetRevision?: () => ?string,
  openInDiffViewOption?: boolean,
};

type DefaultProps = {
  onFileChecked: (filePath: NuclideUri) => void,
  checkedFiles: ?Map<NuclideUri, Set<NuclideUri>>,
};

const ANALYTICS_PREFIX = 'changed-files-view';
const DEFAULT_ANALYTICS_SOURCE_KEY = 'command';

export class MultiRootChangedFilesView extends React.PureComponent<Props> {
  _subscriptions: UniversalDisposable;
  _itemSelector: string;

  constructor(props: Props) {
    super(props);

    this._itemSelector = `.${
      props.commandPrefix
    }.nuclide-ui-multi-root-file-tree-container .nuclide-changed-file`;
  }

  static defaultProps: DefaultProps = {
    checkedFiles: null,
    onFileChecked: () => {},
  };

  componentDidMount(): void {
    this._subscriptions = new UniversalDisposable();
    const {commandPrefix, openInDiffViewOption} = this.props;
    this._subscriptions.add(
      atom.contextMenu.add({
        [this._itemSelector]: [
          {type: 'separator'},
          {
            label: 'Add file to Mercurial',
            command: `${commandPrefix}:add`,
            shouldDisplay: event => {
              return (
                this._getStatusCodeForFile(event) === FileChangeStatus.UNTRACKED
              );
            },
          },
          {
            label: 'Open file in Diff View',
            command: `${commandPrefix}:open-in-diff-view`,
            shouldDisplay: event => {
              return (
                atom.packages.isPackageLoaded('fb-diff-view') &&
                openInDiffViewOption
              );
            },
          },
          {
            label: 'Revert File',
            command: `${commandPrefix}:revert`,
            shouldDisplay: event => {
              const statusCode = this._getStatusCodeForFile(event);
              if (statusCode == null) {
                return false;
              }
              return RevertibleStatusCodes.includes(statusCode);
            },
          },
          {
            label: 'Delete File',
            command: `${commandPrefix}:delete-file`,
            shouldDisplay: event => {
              const statusCode = this._getStatusCodeForFile(event);
              return statusCode !== FileChangeStatus.REMOVED;
            },
          },
          {
            label: 'Goto File',
            command: `${commandPrefix}:goto-file`,
          },
          {
            label: 'Copy File Name',
            command: `${commandPrefix}:copy-file-name`,
          },
          {
            label: 'Copy Full Path',
            command: `${commandPrefix}:copy-full-path`,
          },
          {
            label: 'Forget file',
            command: `${commandPrefix}:forget-file`,
            shouldDisplay: event => {
              const statusCode = this._getStatusCodeForFile(event);
              return (
                statusCode !== FileChangeStatus.REMOVED &&
                statusCode !== FileChangeStatus.UNTRACKED
              );
            },
          },
          {type: 'separator'},
        ],
      }),
    );

    this._subscriptions.add(
      atom.commands.add(
        this._itemSelector,
        `${commandPrefix}:goto-file`,
        event => {
          const filePath = this._getFilePathFromEvent(event);
          if (filePath != null && filePath.length) {
            goToLocation(filePath);
          }
        },
      ),
    );

    this._subscriptions.add(
      atom.commands.add(
        this._itemSelector,
        `${commandPrefix}:copy-full-path`,
        event => {
          atom.clipboard.write(
            nuclideUri.getPath(this._getFilePathFromEvent(event) || ''),
          );
        },
      ),
    );
    this._subscriptions.add(
      atom.commands.add(
        this._itemSelector,
        `${commandPrefix}:delete-file`,
        event => {
          const nuclideFilePath = this._getFilePathFromEvent(event);
          this._handleDeleteFile(nuclideFilePath);
        },
      ),
    );
    this._subscriptions.add(
      atom.commands.add(
        this._itemSelector,
        `${commandPrefix}:copy-file-name`,
        event => {
          atom.clipboard.write(
            nuclideUri.basename(this._getFilePathFromEvent(event) || ''),
          );
        },
      ),
    );
    this._subscriptions.add(
      atom.commands.add(this._itemSelector, `${commandPrefix}:add`, event => {
        const filePath = this._getFilePathFromEvent(event);
        if (filePath != null && filePath.length) {
          this._handleAddFile(filePath);
        }
      }),
    );
    this._subscriptions.add(
      atom.commands.add(
        this._itemSelector,
        `${commandPrefix}:revert`,
        event => {
          const filePath = this._getFilePathFromEvent(event);
          if (filePath != null && filePath.length) {
            this._handleRevertFile(filePath);
          }
        },
      ),
    );
    this._subscriptions.add(
      atom.commands.add(
        this._itemSelector,
        `${commandPrefix}:open-in-diff-view`,
        event => {
          const filePath = this._getFilePathFromEvent(event);
          if (filePath != null && filePath.length) {
            this._handleOpenFileInDiffView(filePath);
          }
        },
      ),
    );
    this._subscriptions.add(
      atom.commands.add(
        this._itemSelector,
        `${commandPrefix}:forget-file`,
        event => {
          const filePath = this._getFilePathFromEvent(event);
          if (filePath != null && filePath.length) {
            this._handleForgetFile(filePath);
          }
        },
      ),
    );
  }

  _getStatusCodeForFile(event: MouseEvent): ?number {
    // Walk up the DOM tree to the element containing the relevant data- attributes.
    const target = ((event.target: any): HTMLElement).closest(
      '.nuclide-changed-file',
    );
    invariant(target);
    const filePath = target.getAttribute('data-path');
    const rootPath = target.getAttribute('data-root');
    // $FlowFixMe
    const fileStatusesForRoot = this.props.fileStatuses.get(rootPath);
    invariant(fileStatusesForRoot, 'Invalid rootpath');
    // $FlowFixMe
    const statusCode = fileStatusesForRoot.get(filePath);
    return statusCode;
  }

  _getFilePathFromEvent(event: Event): NuclideUri {
    const eventTarget: HTMLElement = (event.currentTarget: any);
    // $FlowFixMe
    return eventTarget.getAttribute('data-path');
  }

  _getAnalyticsSurface(): string {
    const {analyticsSurface} = this.props;
    return analyticsSurface == null ? 'n/a' : analyticsSurface;
  }

  _handleAddFile = (
    filePath: string,
    analyticsSource?: string = DEFAULT_ANALYTICS_SOURCE_KEY,
  ): void => {
    addPath(filePath);
    track(`${ANALYTICS_PREFIX}-add-file`, {
      source: analyticsSource,
      surface: this._getAnalyticsSurface(),
    });
  };

  _handleDeleteFile = (
    filePath: string,
    analyticsSource?: string = DEFAULT_ANALYTICS_SOURCE_KEY,
  ): void => {
    confirmAndDeletePath(filePath);
    track(`${ANALYTICS_PREFIX}-delete-file`, {
      source: analyticsSource,
      surface: this._getAnalyticsSurface(),
    });
  };

  _handleForgetFile = (
    filePath: string,
    analyticsSource?: string = DEFAULT_ANALYTICS_SOURCE_KEY,
  ): void => {
    forgetPath(filePath);
    track(`${ANALYTICS_PREFIX}-forget-file`, {
      source: analyticsSource,
      surface: this._getAnalyticsSurface(),
    });
  };

  _handleOpenFileInDiffView = (
    filePath: string,
    analyticsSource?: string = DEFAULT_ANALYTICS_SOURCE_KEY,
  ): void => {
    openFileInDiffView(filePath);
    track(`${ANALYTICS_PREFIX}-file-in-diff-view`, {
      source: analyticsSource,
      surface: this._getAnalyticsSurface(),
    });
  };

  _handleRevertFile = (
    filePath: string,
    analyticsSource?: string = DEFAULT_ANALYTICS_SOURCE_KEY,
  ): void => {
    const {getRevertTargetRevision} = this.props;
    let targetRevision = null;
    if (getRevertTargetRevision != null) {
      targetRevision = getRevertTargetRevision();
    }
    confirmAndRevertPath(filePath, targetRevision);
    track(`${ANALYTICS_PREFIX}-revert-file`, {
      source: analyticsSource,
      surface: this._getAnalyticsSurface(),
    });
  };

  render(): React.Node {
    const {
      checkedFiles: checkedFilesByRoot,
      commandPrefix,
      enableInlineActions,
      fileStatuses: fileStatusesByRoot,
      hideEmptyFolders,
      onFileChecked,
      onFileChosen,
      onMarkFileResolved,
      openInDiffViewOption,
      selectedFile,
    } = this.props;
    if (fileStatusesByRoot.size === 0) {
      return (
        <TreeList showArrows={true}>
          <TreeItem>No changes</TreeItem>
        </TreeList>
      );
      // The 'showArrows' is so CSS styling gives this the same indent as
      // real changes do (which themselves have showArrows=true).
    }
    const shouldShowFolderName = fileStatusesByRoot.size > 1;
    return (
      <div
        className={classnames(
          commandPrefix,
          'nuclide-ui-multi-root-file-tree-container',
        )}>
        {Array.from(fileStatusesByRoot.entries()).map(
          ([root, fileStatuses]) => {
            if (fileStatuses.size == null && hideEmptyFolders) {
              return null;
            }
            const checkedFiles =
              checkedFilesByRoot == null ? null : checkedFilesByRoot.get(root);
            return (
              // $FlowFixMe(>=0.53.0) Flow suppress
              <ChangedFilesList
                checkedFiles={checkedFiles}
                enableInlineActions={enableInlineActions === true}
                fileStatuses={fileStatuses}
                generatedTypes={this.props.generatedTypes}
                key={root}
                onAddFile={this._handleAddFile}
                onDeleteFile={this._handleDeleteFile}
                onFileChecked={onFileChecked}
                onFileChosen={onFileChosen}
                onForgetFile={this._handleForgetFile}
                onMarkFileResolved={onMarkFileResolved}
                onOpenFileInDiffView={this._handleOpenFileInDiffView}
                openInDiffViewOption={openInDiffViewOption || false}
                onRevertFile={this._handleRevertFile}
                rootPath={root}
                selectedFile={selectedFile}
                shouldShowFolderName={shouldShowFolderName}
              />
            );
          },
        )}
      </div>
    );
  }

  componentWillUnmount(): void {
    this._subscriptions.dispose();
  }
}
