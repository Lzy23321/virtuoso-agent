; Controlled managed-session Maestro simulation runtime.

procedure(vaSimulationRunJsonStringList(values)
	let((text separator)
		text = ""
		separator = ""
		foreach(value values
			text = strcat(text separator vaJsonString(value))
			separator = ","
		)
		text
	)
)

procedure(vaSimulationRunRestoreTests(session enabledTests)
	maeEnableTests(?all t ?enable nil ?session session)
	when(enabledTests
		maeEnableTests(?testNames enabledTests ?enable t ?session session)
	)
)

procedure(vaSimulationRunData(
	library cell view selectionLevel requestedTestName progressPath
)
	let((
		session allTests enabledTests selectedTests setupDatabase historyName
		historyEntry resultsRoot progressData waitCaptured waitCompleted
	)
		unless(member(selectionLevel list("test" "maestro"))
			error("Unsupported simulation selection level %s.\n" selectionLevel)
		)
		session = maeOpenSetup(
			library cell view
			?mode "a"
			?application "Assembler"
		)
		unless(session
			error("Could not open Maestro setup %s/%s/%s.\n" library cell view)
		)
		unless(maeIsValidMaestroSession(session)
			error("Invalid Maestro setup %s/%s/%s.\n" library cell view)
		)
		allTests = maeGetSetup(?typeName "tests" ?enabled 'all ?session session)
		enabledTests = maeGetSetup(?typeName "tests" ?enabled t ?session session)
		if(selectionLevel == "test" then
			progn(
				unless(member(requestedTestName allTests)
					error("Could not find Maestro test %s.\n" requestedTestName)
				)
				selectedTests = list(requestedTestName)
			)
		else
			progn(
				unless(enabledTests
					error("The Maestro setup has no enabled tests.\n")
				)
				selectedTests = enabledTests
			)
		)
		unwindProtect(
			progn(
				when(selectionLevel == "test"
					maeEnableTests(?all t ?enable nil ?session session)
					maeEnableTests(?testNames selectedTests ?enable t ?session session)
				)
				historyName = maeRunSimulation(?session session)
				unless(historyName
					error("Maestro simulation did not return a history name.\n")
				)
				setupDatabase = axlGetMainSetupDB(session)
				unless(setupDatabase
					error("Could not get the Maestro setup database.\n")
				)
				historyEntry = axlGetHistoryEntry(setupDatabase historyName)
				unless(historyEntry && historyEntry != 0
					error("Could not resolve Maestro history %s.\n" historyName)
				)
				resultsRoot = axlGetHistoryResultsDir(historyEntry)
				unless(resultsRoot
					error("Could not resolve results directory for history %s.\n" historyName)
				)
				progressData = sprintf(
					nil
					"{\"historyName\":%s,\"resultsRoot\":%s,\"tests\":[%s]}"
					vaJsonString(historyName)
					vaJsonString(resultsRoot)
					vaSimulationRunJsonStringList(selectedTests)
				)
				vaSessionWriteResult(progressPath vaOkEnvelope(progressData))
				; In a long-lived managed session Cadence can leave an internal event
				; callback registered after an earlier run.  A later maeWaitUntilDone
				; may then signal an error even though the submitted history continues
				; normally.  Isolate only the wait so the bridge can fall back to
				; axlGetRunStatus without misclassifying the simulation as failed.
				waitCaptured = errset(maeWaitUntilDone(list(historyName)) t)
				waitCompleted = if(waitCaptured then t else nil)
				list(historyName resultsRoot selectedTests waitCompleted)
			)
			when(selectionLevel == "test"
				vaSimulationRunRestoreTests(session enabledTests)
			)
		)
	)
)

procedure(vaSimulationRunV1(
	library cell view selectionLevel requestedTestName progressPath resultPath
)
	let((captured data resultData)
		captured = errset(
			vaSimulationRunData(
				library cell view selectionLevel requestedTestName progressPath
			)
			t
		)
		if(captured && car(captured) then
			progn(
				data = car(captured)
				resultData = sprintf(
					nil
					"{\"historyName\":%s,\"resultsRoot\":%s,\"tests\":[%s],\"waitCompleted\":%s}"
					vaJsonString(nth(0 data))
					vaJsonString(nth(1 data))
					vaSimulationRunJsonStringList(nth(2 data))
					if(nth(3 data) then "true" else "false")
				)
				vaSessionWriteResult(resultPath vaOkEnvelope(resultData))
			)
		else
			vaSessionWriteResult(
				resultPath
				vaErrorEnvelope(
					"MAESTRO_SIMULATION_FAILED"
					sprintf(nil "Could not run Maestro setup %s/%s/%s." library cell view)
				)
			)
		)
	)
)

procedure(vaSimulationRunStatusV1(
	library cell view historyName resultPath
)
	let((captured session statusData resultData)
		captured = errset(
			progn(
				session = maeOpenSetup(
					library cell view
					?mode "a"
					?application "Assembler"
				)
				unless(session
					error("Could not open Maestro setup %s/%s/%s.\n" library cell view)
				)
				statusData = axlGetRunStatus(session ?historyName historyName)
				unless(statusData && length(statusData) >= 2
					error("Could not query run status for Maestro history %s.\n" historyName)
				)
				sprintf(
					nil
					"{\"historyName\":%s,\"completed\":%L,\"total\":%L}"
					vaJsonString(historyName)
					nth(0 statusData)
					nth(1 statusData)
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
					"MAESTRO_RUN_STATUS_FAILED"
					sprintf(nil "Could not query Maestro history %s." historyName)
				)
			)
		)
	)
)
