import type { ReactNode } from 'react'
import { formatTime, formatSignedTime } from './format'

type SummaryPhaseRecord = {
  id: string
  name: string
  expectedDuration: number
  actualDuration: number
  skipped: boolean
}

type TreatmentSummaryCardProps = {
  totalExpectedDuration: number
  totalActualDuration: number
  totalOvertimeDuration: number
  phaseRecords: SummaryPhaseRecord[]
  /*
    Total logged interruption/lost time for this treatment, in
    seconds. Omitted or 0 hides the clinical/interruption/total
    breakdown entirely - it only adds anything to say once a
    treatment actually had interruptions.
  */
  interruptionDuration?: number
  /*
    Total chair time in seconds (patient seated -> patient left),
    independent of the phase-timing engine above. null/undefined
    means it was never recorded for this treatment - not zero - so
    the row is hidden rather than showing a misleading 00:00.
  */
  chairTimeDuration?: number | null
  /*
    Optional classification tags ("Difficult", "Retreatment", ...).
    Omitted or empty hides the row entirely.
  */
  tags?: string[]
  footer?: ReactNode
}

/*
  Expected/Actual/Overtime totals plus the per-phase breakdown table.
  Shared by the "just completed this treatment" summary screen and
  the read-only historical Treatment Detail screen, so both look
  identical - it's the same data shape either way.
*/

function TreatmentSummaryCard({
  totalExpectedDuration,
  totalActualDuration,
  totalOvertimeDuration,
  phaseRecords,
  interruptionDuration = 0,
  chairTimeDuration = null,
  tags = [],
  footer,
}: TreatmentSummaryCardProps) {

  return (

    <div className="summary-card">

      {tags.length > 0 && (

        <div className="summary-tags">
          {tags.map(tag => (
            <span className="summary-tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>

      )}


      <div className="summary-totals">

        <div className="summary-stat">
          <span className="summary-stat-label">Expected</span>
          <span className="summary-stat-value">
            {formatTime(totalExpectedDuration)}
          </span>
        </div>

        <div className="summary-stat">
          <span className="summary-stat-label">Actual</span>
          <span className="summary-stat-value">
            {formatTime(totalActualDuration)}
          </span>
        </div>

        <div
          className={`summary-stat ${
            totalOvertimeDuration > 0
              ? 'summary-stat-overtime'
              : ''
          }`}
        >
          <span className="summary-stat-label">Overtime</span>
          <span className="summary-stat-value">
            +{formatTime(totalOvertimeDuration)}
          </span>
        </div>

      </div>


      {(interruptionDuration > 0 || chairTimeDuration != null) && (

        <div className="summary-time-accounting">

          {chairTimeDuration != null && (
            <div className="summary-time-accounting-row summary-time-accounting-chair">
              <span>Chair time</span>
              <span>{formatTime(chairTimeDuration)}</span>
            </div>
          )}

          <div className="summary-time-accounting-row">
            <span>Clinical phase time</span>
            <span>{formatTime(totalActualDuration)}</span>
          </div>

          {interruptionDuration > 0 && (
            <div className="summary-time-accounting-row">
              <span>Interruption time</span>
              <span>+{formatTime(interruptionDuration)}</span>
            </div>
          )}

          <div className="summary-time-accounting-row summary-time-accounting-total">
            <span>Total treatment time</span>
            <span>
              {formatTime(totalActualDuration + interruptionDuration)}
            </span>
          </div>

        </div>

      )}


      <table className="summary-phase-table">

        <thead>
          <tr>
            <th>Phase</th>
            <th>Expected</th>
            <th>Actual</th>
            <th>Difference</th>
          </tr>
        </thead>

        <tbody>

          {phaseRecords.map(record => {

            const difference =
              record.actualDuration -
              record.expectedDuration

            return (

              <tr key={record.id}>

                <td>
                  {record.name}
                  {record.skipped && (
                    <span className="summary-skipped-label">
                      {' '}(skipped)
                    </span>
                  )}
                </td>

                <td>
                  {formatTime(record.expectedDuration)}
                </td>

                <td>
                  {formatTime(record.actualDuration)}
                </td>

                <td
                  className={
                    difference > 0
                      ? 'summary-diff-over'
                      : difference < 0
                        ? 'summary-diff-under'
                        : ''
                  }
                >
                  {formatSignedTime(difference)}
                </td>

              </tr>

            )

          })}

        </tbody>

      </table>


      {footer}

    </div>

  )

}

export default TreatmentSummaryCard
