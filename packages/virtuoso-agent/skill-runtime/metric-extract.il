; Controlled managed-session MAE Detail output-view extraction runtime.

procedure(vaMetricExtractMaeOutputViewV1(
	library cell view historyName csvPath resultPath
)
	let((captured)
		captured = errset(
			let((session setupDatabase historyEntry exported)
				session = maeOpenSetup(
					library cell view
					?mode "r"
					?application "Assembler"
				)
				unless(session
					error("Could not open Maestro setup %s/%s/%s.\n" library cell view)
				)
				setupDatabase = axlGetMainSetupDB(session)
				unless(setupDatabase
					error("Could not get the Maestro setup database.\n")
				)
				historyEntry = axlGetHistoryEntry(setupDatabase historyName)
				unless(historyEntry && historyEntry != 0
					error("Could not find Maestro history %s.\n" historyName)
				)
				exported = maeExportOutputView(
					?session session
					?fileName csvPath
					?view "Detail"
					?historyName historyName
				)
				unless(exported
					error("Could not export Maestro history %s.\n" historyName)
				)
				sprintf(
					nil
					"{\"historyName\":%s,\"csvPath\":%s}"
					vaJsonString(historyName)
					vaJsonString(csvPath)
				)
			)
			t
		)
		if(captured && car(captured) then
			vaSessionWriteResult(resultPath vaOkEnvelope(car(captured)))
		else
			vaSessionWriteResult(
				resultPath
				vaErrorEnvelope(
					"MAE_OUTPUT_VIEW_EXPORT_FAILED"
					sprintf(nil "Could not export Maestro history %s." historyName)
				)
			)
		)
	)
)
