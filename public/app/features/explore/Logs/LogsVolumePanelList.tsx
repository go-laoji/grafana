import { css } from '@emotion/css';
import { flatten, groupBy, mapValues, sortBy } from 'lodash';
import { useCallback, useMemo } from 'react';
import * as React from 'react';

import {
  AbsoluteTimeRange,
  DataFrame,
  DataQueryResponse,
  DataTopic,
  dateTime,
  EventBus,
  getFrameDisplayName,
  GrafanaTheme2,
  LoadingState,
  shallowCompare,
  SplitOpen,
  TimeRange,
  TimeZone,
} from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { config } from '@grafana/runtime';
import { Button, InlineField, Alert, useStyles2, SeriesVisibilityChangeMode } from '@grafana/ui';

import { mergeLogsVolumeDataFrames, isLogsVolumeLimited, getLogsVolumeMaximumRange } from '../../logs/utils';
import { SupplementaryResultError } from '../SupplementaryResultError';

import { LogsVolumePanel } from './LogsVolumePanel';
import { isTimeoutErrorResponse } from './utils/logsVolumeResponse';

type Props = {
  logsVolumeData: DataQueryResponse | undefined;
  absoluteRange: AbsoluteTimeRange;
  timeZone: TimeZone;
  splitOpen: SplitOpen;
  width: number;
  onUpdateTimeRange: (timeRange: AbsoluteTimeRange) => void;
  onLoadLogsVolume: () => void;
  onDisplayedSeriesChanged: (series: string[]) => void;
  eventBus: EventBus;
  onClose?(): void;
  toggleLegendRef?: React.MutableRefObject<(name: string | undefined, mode: SeriesVisibilityChangeMode) => void>;
};

export const LogsVolumePanelList = ({
  logsVolumeData,
  absoluteRange,
  onUpdateTimeRange,
  width,
  onLoadLogsVolume,
  onDisplayedSeriesChanged,
  eventBus,
  splitOpen,
  timeZone,
  onClose,
  toggleLegendRef,
}: Props) => {
  const {
    logVolumes,
    maximumValue: allLogsVolumeMaximumValue,
    maximumRange: allLogsVolumeMaximumRange,
    annotations,
  } = useMemo(() => {
    let maximumValue = -Infinity;
    const data = logsVolumeData?.data.filter((frame: DataFrame) => frame.meta?.dataTopic !== DataTopic.Annotations);
    const annotations =
      logsVolumeData?.data.filter((frame: DataFrame) => frame.meta?.dataTopic === DataTopic.Annotations) || [];
    const sorted = sortBy(data || [], 'meta.custom.datasourceName');
    const grouped = groupBy(sorted, 'meta.custom.datasourceName');
    const logVolumes = mapValues(grouped, (value) => {
      const mergedData = mergeLogsVolumeDataFrames(value);
      maximumValue = Math.max(maximumValue, mergedData.maximum);
      return mergedData.dataFrames;
    });
    const maximumRange = getLogsVolumeMaximumRange(flatten(Object.values(logVolumes)));
    return {
      maximumValue,
      maximumRange,
      logVolumes,
      annotations,
    };
  }, [logsVolumeData]);

  const styles = useStyles2(getStyles);

  const numberOfLogVolumes = Object.keys(logVolumes).length;

  const containsZoomed = Object.values(logVolumes).some((data: DataFrame[]) => {
    const zoomRatio = logsLevelZoomRatio(data, absoluteRange);
    return !isLogsVolumeLimited(data) && zoomRatio && zoomRatio < 1;
  });

  const canShowPartialData =
    config.featureToggles.lokiShardSplitting && logsVolumeData && logsVolumeData.data.length > 0;
  const timeoutError = isTimeoutErrorResponse(logsVolumeData);

  const from = dateTime(Math.max(absoluteRange.from, allLogsVolumeMaximumRange.from));
  const to = dateTime(Math.min(absoluteRange.to, allLogsVolumeMaximumRange.to));
  const visibleRange: TimeRange = { from, to, raw: { from, to } };

  const handleHiddenSeriesChanged = useCallback(
    (hiddenSeries: string[]) => {
      // Not supported
      if (numberOfLogVolumes > 1) {
        return;
      }
      const allLevels = [
        ...new Set(
          Object.values(logVolumes)
            .map((series) => series.map((dataFrame) => getFrameDisplayName(dataFrame)))
            .flat()
        ),
      ];
      const displayedLevels = allLevels.filter((level) => !hiddenSeries.includes(level));
      onDisplayedSeriesChanged(shallowCompare(allLevels, displayedLevels) ? [] : displayedLevels);
    },
    [logVolumes, numberOfLogVolumes, onDisplayedSeriesChanged]
  );

  if (logsVolumeData?.state === LoadingState.Loading) {
    return (
      <span>
        <Trans i18nKey="explore.logs-volume-panel-list.loading">Loading...</Trans>
      </span>
    );
  } else if (timeoutError && !canShowPartialData) {
    return (
      <SupplementaryResultError
        title={t('explore.logs-volume-panel-list.title-unable-to-show-log-volume', 'Unable to show log volume')}
        // Using info to avoid users thinking that the actual query has failed.
        message={
          <>
            <p>
              <Trans i18nKey="explore.logs.logs-volume.much-data">
                The query is trying to access too much data. Try one or more of the following:
              </Trans>
            </p>
            <ul>
              <li>
                <Trans i18nKey="explore.logs.logs-volume.add-filters">
                  Add more labels to your query to narrow down your search.
                </Trans>
              </li>
              <li>
                <Trans i18nKey="explore.logs.logs-volume.decrease-timerange">
                  Decrease the time range of your query.
                </Trans>
              </li>
            </ul>
          </>
        }
        severity="info"
        suggestedAction="Retry"
        onSuggestedAction={onLoadLogsVolume}
        onRemove={onClose}
      />
    );
  } else if (logsVolumeData?.error !== undefined && !canShowPartialData) {
    return (
      <SupplementaryResultError
        error={logsVolumeData.error}
        title={t(
          'explore.logs-volume-panel-list.title-failed-volume-query',
          'Failed to load log volume for this query'
        )}
      />
    );
  }

  if (numberOfLogVolumes === 0 && logsVolumeData?.state !== LoadingState.Streaming) {
    return (
      <div className={styles.alertContainer}>
        <Alert
          severity="info"
          title={t('explore.logs-volume-panel-list.title-no-logs-volume-available', 'No logs volume available')}
        >
          <Trans i18nKey="explore.logs-volumne-panel-list.body-no-logs-volume-available">
            No volume information available for the current queries and time range.
          </Trans>
        </Alert>
      </div>
    );
  }

  return (
    <div className={styles.listContainer}>
      {timeoutError && canShowPartialData && (
        <SupplementaryResultError
          title={t('explore.logs-volume-panel-list.title-showing-partial-data', 'Showing partial data')}
          message="The query is trying to access too much data and some sharded requests could not be completed. Try decreasing the time range or adding more labels to your query."
          severity="info"
          dismissable
        />
      )}
      {Object.keys(logVolumes).map((name, index) => {
        return (
          <LogsVolumePanel
            toggleLegendRef={toggleLegendRef}
            key={index}
            timeRange={visibleRange}
            allLogsVolumeMaximum={allLogsVolumeMaximumValue}
            width={width}
            logsVolumeData={{ data: logVolumes[name], state: logsVolumeData?.state }}
            onUpdateTimeRange={onUpdateTimeRange}
            timeZone={timeZone}
            splitOpen={splitOpen}
            onLoadLogsVolume={onLoadLogsVolume}
            // TODO: Support filtering level from multiple log levels
            onHiddenSeriesChanged={numberOfLogVolumes > 1 ? () => {} : handleHiddenSeriesChanged}
            eventBus={eventBus}
            annotations={annotations}
          />
        );
      })}
      {containsZoomed && (
        <div className={styles.extraInfoContainer}>
          <InlineField
            label={t('explore.logs-volume-panel-list.label-reload-log-volume', 'Reload log volume')}
            transparent
          >
            <Button size="xs" icon="sync" variant="secondary" onClick={onLoadLogsVolume} id="reload-volume" />
          </InlineField>
        </div>
      )}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => {
  return {
    listContainer: css({
      paddingTop: '10px',
    }),
    extraInfoContainer: css({
      display: 'flex',
      justifyContent: 'end',
      position: 'absolute',
      right: '5px',
      top: '5px',
    }),
    oldInfoText: css({
      fontSize: theme.typography.bodySmall.fontSize,
      color: theme.colors.text.secondary,
    }),
    alertContainer: css({
      width: '50%',
      minWidth: `${theme.breakpoints.values.sm}px`,
      margin: '0 auto',
    }),
  };
};

function logsLevelZoomRatio(
  logsVolumeData: DataFrame[] | undefined,
  selectedTimeRange: AbsoluteTimeRange
): number | undefined {
  const dataRange = logsVolumeData && logsVolumeData[0] && logsVolumeData[0].meta?.custom?.absoluteRange;
  return dataRange ? (selectedTimeRange.from - selectedTimeRange.to) / (dataRange.from - dataRange.to) : undefined;
}
